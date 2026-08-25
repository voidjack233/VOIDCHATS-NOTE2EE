import valkey from '../../valkey.js';

export interface SecurityCounterState {
  attempts: number;
  attemptsLeft: number;
  exhausted: boolean;
  retryAfterSeconds: number;
}

export interface SecurityCounterClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

interface IncrementCounterOptions {
  keys: unknown | readonly unknown[];
  maxAttempts: unknown;
  windowSeconds: unknown;
  client?: SecurityCounterClient;
}

interface ReadCounterOptions {
  keys: unknown | readonly unknown[];
  maxAttempts: unknown;
  client?: SecurityCounterClient;
}

const INCREMENT_FIXED_WINDOW_SCRIPT = `
local maxAttempts = tonumber(ARGV[1])
local windowSeconds = tonumber(ARGV[2])
local highestAttempts = 0
local exhausted = 0
local retryAfterSeconds = 0

for _, key in ipairs(KEYS) do
  local keyType = redis.call('TYPE', key).ok
  if keyType ~= 'none' and keyType ~= 'string' then
    redis.call('DEL', key)
    keyType = 'none'
  end

  local raw = keyType == 'string' and redis.call('GET', key) or nil
  local attempts = tonumber(raw) or 0
  local ttlMilliseconds = keyType == 'string' and redis.call('PTTL', key) or -2
  attempts = attempts + 1

  if ttlMilliseconds == -2 or ttlMilliseconds == -1 then
    redis.call('SET', key, attempts, 'EX', windowSeconds)
    ttlMilliseconds = windowSeconds * 1000
  else
    redis.call('SET', key, attempts, 'KEEPTTL')
  end

  highestAttempts = math.max(highestAttempts, attempts)
  if attempts >= maxAttempts then
    exhausted = 1
    retryAfterSeconds = math.max(retryAfterSeconds, math.ceil(ttlMilliseconds / 1000))
  end
end

return {
  highestAttempts,
  math.max(0, maxAttempts - highestAttempts),
  exhausted,
  retryAfterSeconds
}
`;

const CHECK_FIXED_WINDOW_SCRIPT = `
local maxAttempts = tonumber(ARGV[1])
local highestAttempts = 0
local exhausted = 0
local retryAfterSeconds = 0

for _, key in ipairs(KEYS) do
  local keyType = redis.call('TYPE', key).ok
  if keyType ~= 'none' and keyType ~= 'string' then
    redis.call('DEL', key)
    keyType = 'none'
  end

  local attempts = 0
  local ttlMilliseconds = 0
  if keyType == 'string' then
    attempts = tonumber(redis.call('GET', key)) or 0
    ttlMilliseconds = math.max(0, redis.call('PTTL', key))
  end

  highestAttempts = math.max(highestAttempts, attempts)
  if attempts >= maxAttempts then
    exhausted = 1
    retryAfterSeconds = math.max(retryAfterSeconds, math.ceil(ttlMilliseconds / 1000))
  end
end

return {
  highestAttempts,
  math.max(0, maxAttempts - highestAttempts),
  exhausted,
  retryAfterSeconds
}
`;

export class SecurityCounterUnavailableError extends Error {
  readonly code = 'SECURITY_COUNTER_UNAVAILABLE';

  constructor(cause: unknown) {
    super('Security counter is unavailable', { cause });
    this.name = 'SecurityCounterUnavailableError';
  }
}

function normalizeKeys(keys: unknown | readonly unknown[]): string[] {
  const normalized = [...new Set(
    (Array.isArray(keys) ? keys : [keys])
      .map((key) => String(key || '').trim())
      .filter(Boolean),
  )];
  if (normalized.length === 0) {
    throw new TypeError('At least one security counter key is required');
  }
  return normalized;
}

function normalizePositiveInteger(value: unknown, name: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return normalized;
}

function parseCounterState(result: unknown): SecurityCounterState {
  const values = Array.isArray(result) ? result : [];
  return {
    attempts: Math.max(0, Number(values[0]) || 0),
    attemptsLeft: Math.max(0, Number(values[1]) || 0),
    exhausted: Number(values[2]) === 1,
    retryAfterSeconds: Math.max(0, Number(values[3]) || 0),
  };
}

async function evaluateCounterScript(
  client: SecurityCounterClient,
  script: string,
  keys: string[],
  args: Array<string | number>,
): Promise<unknown> {
  try {
    return await client.eval(script, keys.length, ...keys, ...args);
  } catch (error) {
    if (error instanceof SecurityCounterUnavailableError) throw error;
    throw new SecurityCounterUnavailableError(error);
  }
}

export async function incrementFixedWindowCounters({
  keys,
  maxAttempts,
  windowSeconds,
  client = valkey,
}: IncrementCounterOptions): Promise<SecurityCounterState> {
  const normalizedKeys = normalizeKeys(keys);
  const normalizedMaxAttempts = normalizePositiveInteger(maxAttempts, 'maxAttempts');
  const normalizedWindowSeconds = normalizePositiveInteger(windowSeconds, 'windowSeconds');
  const result = await evaluateCounterScript(
    client,
    INCREMENT_FIXED_WINDOW_SCRIPT,
    normalizedKeys,
    [normalizedMaxAttempts, normalizedWindowSeconds],
  );
  return parseCounterState(result);
}

export async function getFixedWindowCounterState({
  keys,
  maxAttempts,
  client = valkey,
}: ReadCounterOptions): Promise<SecurityCounterState> {
  const normalizedKeys = normalizeKeys(keys);
  const normalizedMaxAttempts = normalizePositiveInteger(maxAttempts, 'maxAttempts');
  const result = await evaluateCounterScript(
    client,
    CHECK_FIXED_WINDOW_SCRIPT,
    normalizedKeys,
    [normalizedMaxAttempts],
  );
  return parseCounterState(result);
}

export async function clearFixedWindowCounters(
  keys: unknown | readonly unknown[],
  client: SecurityCounterClient = valkey,
): Promise<void> {
  const normalizedKeys = normalizeKeys(keys);
  try {
    await client.del(...normalizedKeys);
  } catch (error) {
    throw new SecurityCounterUnavailableError(error);
  }
}
