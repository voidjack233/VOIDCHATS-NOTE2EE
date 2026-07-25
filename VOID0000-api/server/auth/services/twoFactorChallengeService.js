import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import valkey from '../../valkey.js';
import { DeviceFingerprint } from '../../utils/deviceFingerprint.js';
import { getClientIP } from '../../utils/securityUtils.js';
import { getTwoFactorCodeSecret } from '../config/authSecrets.js';
import {
  buildAllowedTwoFactorMethods,
} from './twoFactorMethodService.js';
import {
  clearFixedWindowCounters,
  getFixedWindowCounterState,
  incrementFixedWindowCounters,
} from './securityCounterService.js';

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
