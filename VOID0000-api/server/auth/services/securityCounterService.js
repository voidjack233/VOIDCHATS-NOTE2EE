import valkey from '../../valkey.js';

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
  constructor(cause) {
    super('Security counter is unavailable', { cause });
    this.name = 'SecurityCounterUnavailableError';
    this.code = 'SECURITY_COUNTER_UNAVAILABLE';
  }
}

function normalizeKeys(keys) {
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

function normalizePositiveInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return normalized;
}

function parseCounterState(result) {
  return {
    attempts: Math.max(0, Number(result?.[0]) || 0),
    attemptsLeft: Math.max(0, Number(result?.[1]) || 0),
    exhausted: Number(result?.[2]) === 1,
    retryAfterSeconds: Math.max(0, Number(result?.[3]) || 0),
  };
}

async function evaluateCounterScript(client, script, keys, args) {
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
}) {
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
}) {
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

export async function clearFixedWindowCounters(keys, client = valkey) {
  const normalizedKeys = normalizeKeys(keys);
  try {
    await client.del(...normalizedKeys);
  } catch (error) {
    throw new SecurityCounterUnavailableError(error);
  }
}
