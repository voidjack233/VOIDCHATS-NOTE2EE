import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import valkey from '../../valkey.js';
import { DeviceFingerprint } from '../../utils/deviceFingerprint.js';
import { getClientIP } from '../../utils/securityUtils.js';
import { getTwoFactorCodeSecret } from '../config/authSecrets.js';
import {
  buildAllowedTwoFactorMethods,
  isTwoFactorMethodAuthorized,
  normalizeTwoFactorMethod,
} from './twoFactorMethodService.js';
import {
  SecurityCounterUnavailableError,
  clearFixedWindowCounters,
  getFixedWindowCounterState,
  incrementFixedWindowCounters,
} from './securityCounterService.js';

const TWO_FACTOR_VERIFY_WINDOW_SEC = 5 * 60;
const TWO_FACTOR_VERIFY_MAX_ATTEMPTS = 5;
const TWO_FACTOR_EMAIL_WINDOW_SEC = 10 * 60;
const TWO_FACTOR_EMAIL_MAX_SENDS = 3;
const TWO_FACTOR_SESSION_WINDOW_SEC = 5 * 60;

const CONSUME_PENDING_TWO_FACTOR_SESSION_SCRIPT = `
local session = redis.call('GET', KEYS[1])
if not session then
  return false
end

redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return session
`;

const UPDATE_PENDING_TWO_FACTOR_SESSION_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 'missing'
end
if current ~= ARGV[1] then
  return 'changed'
end

local ttlMilliseconds = redis.call('PTTL', KEYS[1])
if ttlMilliseconds <= 0 then
  redis.call('DEL', KEYS[1])
  return 'missing'
end

redis.call('SET', KEYS[1], ARGV[2], 'PX', ttlMilliseconds)
return 'updated'
`;

function getTwoFactorSessionKey(twoFactorToken) {
  return `auth:2fa:session:${twoFactorToken}`;
}

function getRequestBinding(req) {
  return {
    deviceFingerprint: DeviceFingerprint.generateFingerprint(req),
    userAgent: req.get('User-Agent') || 'unknown',
  };
}

export function isSameRequestBinding(session, req) {
  const current = getRequestBinding(req);
  return (
    session?.deviceFingerprint === current.deviceFingerprint &&
    session?.userAgent === current.userAgent
  );
}

export function generateEmailCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

export function hashEmailCode(twoFactorToken, code) {
  return crypto
    .createHmac('sha256', getTwoFactorCodeSecret())
    .update(`${twoFactorToken}:${String(code).trim()}`)
    .digest('hex');
}

export async function getPendingTwoFactorSession(twoFactorToken) {
  const raw = await valkey.get(getTwoFactorSessionKey(twoFactorToken));
  return raw ? JSON.parse(raw) : null;
}

export async function savePendingTwoFactorSession(twoFactorToken, session) {
  await valkey.set(
    getTwoFactorSessionKey(twoFactorToken),
    JSON.stringify(session),
    'EX',
    TWO_FACTOR_SESSION_WINDOW_SEC,
  );
}

export async function updatePendingTwoFactorSession(
  twoFactorToken,
  expectedSession,
  nextSession,
  client = valkey,
) {
  try {
    return String(await client.eval(
      UPDATE_PENDING_TWO_FACTOR_SESSION_SCRIPT,
      1,
      getTwoFactorSessionKey(twoFactorToken),
      JSON.stringify(expectedSession),
      JSON.stringify(nextSession),
    ));
  } catch (error) {
    if (error instanceof SecurityCounterUnavailableError) throw error;
    throw new SecurityCounterUnavailableError(error);
  }
}

export async function deletePendingTwoFactorSession(twoFactorToken) {
  await valkey.del(getTwoFactorSessionKey(twoFactorToken));
}

export async function consumePendingTwoFactorSession(twoFactorToken, client = valkey) {
  let rawSession;
  try {
    rawSession = await client.eval(
      CONSUME_PENDING_TWO_FACTOR_SESSION_SCRIPT,
      3,
      getTwoFactorSessionKey(twoFactorToken),
      getTwoFactorVerifyKey(twoFactorToken),
      getTwoFactorEmailKey(twoFactorToken),
    );
  } catch (error) {
    if (error instanceof SecurityCounterUnavailableError) throw error;
    throw new SecurityCounterUnavailableError(error);
  }

  if (typeof rawSession !== 'string' || !rawSession) return null;

  try {
    const session = JSON.parse(rawSession);
    return session && typeof session === 'object' ? session : null;
  } catch {
    return null;
  }
}

export function isSameTwoFactorSessionSnapshot(expectedSession, consumedSession) {
  if (
    !expectedSession ||
    typeof expectedSession !== 'object' ||
    !consumedSession ||
    typeof consumedSession !== 'object'
  ) {
    return false;
  }

  return JSON.stringify(expectedSession) === JSON.stringify(consumedSession);
}

export async function claimVerifiedTwoFactorSession({
  twoFactorToken,
  expectedSession,
  method,
  req,
  queryable,
  verifiedEmailCodeHash = null,
  client = valkey,
  now = Date.now(),
}) {
  const consumedSession = await consumePendingTwoFactorSession(twoFactorToken, client);
  if (!consumedSession) {
    return { status: 'missing', session: null };
  }
  const normalizedMethod = normalizeTwoFactorMethod(method);

  const unchanged = isSameTwoFactorSessionSnapshot(
    expectedSession,
    consumedSession,
  );
  const sameUser = Boolean(
    expectedSession?.userId &&
    String(consumedSession.userId) === String(expectedSession.userId),
  );
  const unexpired = Number.isFinite(Number(consumedSession.expiresAt)) &&
    now <= Number(consumedSession.expiresAt);
  const bindingMatches = isSameRequestBinding(consumedSession, req);

  if (!unchanged || !sameUser || !unexpired || !bindingMatches) {
    return { status: 'changed', session: null };
  }

  if (
    !normalizedMethod ||
    !await isTwoFactorMethodAuthorized(queryable, consumedSession, normalizedMethod)
  ) {
    return { status: 'changed', session: null };
  }

  if (normalizedMethod === 'email') {
    const emailCodeExpiresAt = Number(consumedSession.emailCodeExpiresAt);
    const emailStateMatches = Boolean(
      verifiedEmailCodeHash &&
      consumedSession.emailCodeHash === verifiedEmailCodeHash &&
      consumedSession.emailCodeHash === expectedSession.emailCodeHash &&
      emailCodeExpiresAt === Number(expectedSession.emailCodeExpiresAt) &&
      Number.isFinite(emailCodeExpiresAt) &&
      now <= emailCodeExpiresAt,
    );
    if (!emailStateMatches) {
      return { status: 'changed', session: null };
    }
  }

  return { status: 'consumed', session: consumedSession };
}

export async function create2FASession(userId, req, allowedMethods) {
  const token = uuidv4();
  const normalizedMethods = buildAllowedTwoFactorMethods(
    allowedMethods,
    Array.isArray(allowedMethods) && allowedMethods.includes('backup'),
  );
  if (normalizedMethods.length === 0) {
    throw new Error('Cannot create a 2FA challenge without an authorized method');
  }

  await savePendingTwoFactorSession(token, {
    userId,
    allowedMethods: normalizedMethods,
    ip: getClientIP(req),
    ...getRequestBinding(req),
    userAgent: req.get('User-Agent') || 'unknown',
    expiresAt: Date.now() + TWO_FACTOR_SESSION_WINDOW_SEC * 1000,
  });

  return token;
}

function getTwoFactorVerifyKey(twoFactorToken) {
  return `auth:2fa:verify:${twoFactorToken}`;
}

function getTwoFactorEmailKey(twoFactorToken) {
  return `auth:2fa:email:${twoFactorToken}`;
}

export async function clearTwoFactorAttemptState(twoFactorToken) {
  await valkey.del(getTwoFactorSessionKey(twoFactorToken));
  await clearFixedWindowCounters([
    getTwoFactorVerifyKey(twoFactorToken),
    getTwoFactorEmailKey(twoFactorToken),
  ]);
}

export async function recordTwoFactorFailure(twoFactorToken) {
  const state = await incrementFixedWindowCounters({
    keys: getTwoFactorVerifyKey(twoFactorToken),
    maxAttempts: TWO_FACTOR_VERIFY_MAX_ATTEMPTS,
    windowSeconds: TWO_FACTOR_VERIFY_WINDOW_SEC,
  });
  return {
    ...state,
    blockedUntil: state.exhausted
      ? Date.now() + state.retryAfterSeconds * 1000
      : 0,
  };
}

export async function checkTwoFactorBlocked(twoFactorToken) {
  const state = await getFixedWindowCounterState({
    keys: getTwoFactorVerifyKey(twoFactorToken),
    maxAttempts: TWO_FACTOR_VERIFY_MAX_ATTEMPTS,
  });
  return {
    blocked: state.exhausted,
    retryAfterSeconds: state.retryAfterSeconds,
  };
}

export async function recordTwoFactorEmailSend(twoFactorToken) {
  const state = await incrementFixedWindowCounters({
    keys: getTwoFactorEmailKey(twoFactorToken),
    maxAttempts: TWO_FACTOR_EMAIL_MAX_SENDS + 1,
    windowSeconds: TWO_FACTOR_EMAIL_WINDOW_SEC,
  });
  return state.attempts;
}

export function hasExceededTwoFactorEmailSends(count) {
  return count > TWO_FACTOR_EMAIL_MAX_SENDS;
}

export async function getTwoFactorEmailRetryAfter(twoFactorToken) {
  const state = await getFixedWindowCounterState({
    keys: getTwoFactorEmailKey(twoFactorToken),
    maxAttempts: TWO_FACTOR_EMAIL_MAX_SENDS + 1,
  });
  return state.retryAfterSeconds || TWO_FACTOR_EMAIL_WINDOW_SEC;
}
