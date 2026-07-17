import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import valkey from '../../valkey.js';
import { DeviceFingerprint } from '../../utils/deviceFingerprint.js';
import { getClientIP } from '../../utils/securityUtils.js';
import { getTwoFactorCodeSecret } from '../config/authSecrets.js';

const TWO_FACTOR_VERIFY_WINDOW_SEC = 5 * 60;
const TWO_FACTOR_VERIFY_MAX_ATTEMPTS = 5;
const TWO_FACTOR_EMAIL_WINDOW_SEC = 10 * 60;
const TWO_FACTOR_EMAIL_MAX_SENDS = 3;
const TWO_FACTOR_SESSION_WINDOW_SEC = 5 * 60;

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

export async function deletePendingTwoFactorSession(twoFactorToken) {
  await valkey.del(getTwoFactorSessionKey(twoFactorToken));
}

export async function create2FASession(userId, req) {
  const token = uuidv4();

  await savePendingTwoFactorSession(token, {
    userId,
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
  await valkey.del(
    getTwoFactorSessionKey(twoFactorToken),
    getTwoFactorVerifyKey(twoFactorToken),
    getTwoFactorEmailKey(twoFactorToken),
  );
}

async function getTwoFactorVerifyState(twoFactorToken) {
  const raw = await valkey.get(getTwoFactorVerifyKey(twoFactorToken));
  return raw ? JSON.parse(raw) : { attempts: 0, blockedUntil: 0 };
}

export async function recordTwoFactorFailure(twoFactorToken) {
  const state = await getTwoFactorVerifyState(twoFactorToken);
  state.attempts = (state.attempts || 0) + 1;
  if (state.attempts >= TWO_FACTOR_VERIFY_MAX_ATTEMPTS) {
    state.blockedUntil = Date.now() + TWO_FACTOR_VERIFY_WINDOW_SEC * 1000;
  }
  await valkey.set(
    getTwoFactorVerifyKey(twoFactorToken),
    JSON.stringify(state),
    'EX',
    TWO_FACTOR_VERIFY_WINDOW_SEC,
  );
  return state;
}

export async function checkTwoFactorBlocked(twoFactorToken) {
  const state = await getTwoFactorVerifyState(twoFactorToken);
  const now = Date.now();
  if (state.blockedUntil && now < state.blockedUntil) {
    return {
      blocked: true,
      retryAfterSeconds: Math.ceil((state.blockedUntil - now) / 1000),
    };
  }
  return { blocked: false, retryAfterSeconds: 0 };
}

export async function recordTwoFactorEmailSend(twoFactorToken) {
  const key = getTwoFactorEmailKey(twoFactorToken);
  const count = await valkey.incr(key);
  if (count === 1) {
    await valkey.expire(key, TWO_FACTOR_EMAIL_WINDOW_SEC);
  }
  return count;
}

export function hasExceededTwoFactorEmailSends(count) {
  return count > TWO_FACTOR_EMAIL_MAX_SENDS;
}

export async function getTwoFactorEmailRetryAfter(twoFactorToken) {
  const ttl = await valkey.ttl(getTwoFactorEmailKey(twoFactorToken));
  return ttl > 0 ? ttl : TWO_FACTOR_EMAIL_WINDOW_SEC;
}
