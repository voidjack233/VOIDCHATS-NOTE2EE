import valkey from '../valkey.js';

const CAPTCHA_KEY_PREFIX = 'captcha:challenge:';
const CAPTCHA_TTL_SECONDS = 5 * 60;
const CAPTCHA_MAX_ATTEMPTS = 3;

interface CaptchaStoreClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

export interface CaptchaConsumeResult {
  status: string;
  attempts: number;
  attemptsLeft: number;
  retryAfterSeconds: number;
}

const CONSUME_CAPTCHA_SCRIPT = `
local key = KEYS[1]
local answer = ARGV[1]
local maxAttempts = tonumber(ARGV[2])
local raw = redis.call('GET', key)

if not raw then
  return {'missing', 0, 0, 0}
end

local decoded, challenge = pcall(cjson.decode, raw)
if not decoded or type(challenge) ~= 'table' or type(challenge.solution) ~= 'string' then
  redis.call('DEL', key)
  return {'missing', 0, 0, 0}
end

local attempts = tonumber(challenge.attempts) or 0
if attempts >= maxAttempts then
  redis.call('DEL', key)
  return {'exhausted', attempts, 0, 0}
end

attempts = attempts + 1
if answer == challenge.solution then
  redis.call('DEL', key)
  return {'success', attempts, math.max(0, maxAttempts - attempts), 0}
end

if attempts >= maxAttempts then
  redis.call('DEL', key)
  return {'exhausted', attempts, 0, 0}
end

local ttl = redis.call('TTL', key)
if ttl <= 0 then
  redis.call('DEL', key)
  return {'missing', attempts, 0, 0}
end

challenge.attempts = attempts
redis.call('SET', key, cjson.encode(challenge), 'EX', ttl)
return {'wrong', attempts, math.max(0, maxAttempts - attempts), ttl}
`;

function getCaptchaKey(captchaId: unknown): string {
  return `${CAPTCHA_KEY_PREFIX}${captchaId}`;
}

export async function saveCaptchaChallenge(
  captchaId: string,
  solution: string,
): Promise<void> {
  await valkey.set(
    getCaptchaKey(captchaId),
    JSON.stringify({
      solution,
      attempts: 0,
    }),
    'EX',
    CAPTCHA_TTL_SECONDS,
  );
}

export async function consumeCaptchaChallenge(
  captchaId: string,
  answer: unknown,
  client: CaptchaStoreClient = valkey,
): Promise<CaptchaConsumeResult> {
  const result = await client.eval(
    CONSUME_CAPTCHA_SCRIPT,
    1,
    getCaptchaKey(captchaId),
    String(answer || '').toUpperCase().trim(),
    CAPTCHA_MAX_ATTEMPTS,
  );
  const values = Array.isArray(result) ? result : [];
  return {
    status: String(values[0] || 'missing'),
    attempts: Math.max(0, Number(values[1]) || 0),
    attemptsLeft: Math.max(0, Number(values[2]) || 0),
    retryAfterSeconds: Math.max(0, Number(values[3]) || 0),
  };
}

export async function deleteCaptchaChallenge(captchaId: string): Promise<void> {
  await valkey.del(getCaptchaKey(captchaId));
}

export function getCaptchaChallengeTtl(
  captchaId: string,
  client: CaptchaStoreClient = valkey,
): Promise<number> {
  return client.ttl(getCaptchaKey(captchaId));
}
