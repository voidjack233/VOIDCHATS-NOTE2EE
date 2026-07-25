import crypto from 'node:crypto';

import { DeviceFingerprint } from '../../utils/deviceFingerprint.js';
import { getClientIP } from '../../utils/securityUtils.js';
import {
  clearFixedWindowCounters,
  getFixedWindowCounterState,
  incrementFixedWindowCounters,
} from './securityCounterService.js';

const EMAIL_VERIFICATION_WINDOW_SECONDS = 15 * 60;
const EMAIL_VERIFICATION_MAX_FAILURES = 8;
const EMAIL_VERIFICATION_IP_MAX_FAILURES = 30;
const SENSITIVE_ACTION_WINDOW_SECONDS = 15 * 60;
const SENSITIVE_ACTION_MAX_FAILURES = 5;

export class SecurityLimitExceededError extends Error {
  constructor(code, state) {
    super('Security attempt limit exceeded');
    this.name = 'SecurityLimitExceededError';
    this.code = code;
    this.state = state;
  }
}

function hashKeyPart(...parts) {
  return crypto
    .createHash('sha256')
    .update(parts.map((part) => String(part || '')).join('\n'))
    .digest('hex');
}

function getRequestSource(req) {
  return {
    ip: getClientIP(req) || 'unknown',
    device: DeviceFingerprint.generateFingerprint(req) || 'unknown',
  };
}

function getEmailVerificationKeys({ req, tokenHash, userId }) {
  const { ip } = getRequestSource(req);
  return {
    ip: `auth:email-verify:ip:${hashKeyPart(ip)}`,
    tokenIp: `auth:email-verify:token-ip:${hashKeyPart(tokenHash, ip)}`,
    user: userId
      ? `auth:email-verify:user:${hashKeyPart(userId)}`
      : null,
  };
}

function getSensitiveActionKeys({ req, userId, action }) {
  const { ip, device } = getRequestSource(req);
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!userId || !normalizedAction) {
    throw new TypeError('userId and action are required for a sensitive action limit');
  }
  return [
    `auth:2fa-action:user:${hashKeyPart(userId, normalizedAction)}`,
    `auth:2fa-action:source:${hashKeyPart(userId, normalizedAction, ip, device)}`,
  ];
}

function mergeCounterStates(states) {
  return states.reduce((merged, state) => ({
    attempts: Math.max(merged.attempts, state.attempts),
    attemptsLeft: Math.min(merged.attemptsLeft, state.attemptsLeft),
    exhausted: merged.exhausted || state.exhausted,
    retryAfterSeconds: Math.max(merged.retryAfterSeconds, state.retryAfterSeconds),
  }), {
    attempts: 0,
    attemptsLeft: Number.MAX_SAFE_INTEGER,
    exhausted: false,
    retryAfterSeconds: 0,
  });
}

async function readEmailVerificationState({ req, tokenHash, userId, client }) {
  const keys = getEmailVerificationKeys({ req, tokenHash, userId });
  const states = await Promise.all([
    getFixedWindowCounterState({
      keys: keys.ip,
      maxAttempts: EMAIL_VERIFICATION_IP_MAX_FAILURES,
      client,
    }),
    getFixedWindowCounterState({
      keys: [keys.tokenIp, keys.user].filter(Boolean),
      maxAttempts: EMAIL_VERIFICATION_MAX_FAILURES,
      client,
    }),
  ]);
  return mergeCounterStates(states);
}

export async function assertEmailVerificationAllowed(options) {
  const state = await readEmailVerificationState(options);
  if (state.exhausted) {
    throw new SecurityLimitExceededError('EMAIL_VERIFICATION_RATE_LIMIT', state);
  }
  return state;
}

export async function recordEmailVerificationFailure({
  req,
  tokenHash,
  userId,
  client,
}) {
  const keys = getEmailVerificationKeys({ req, tokenHash, userId });
  const states = await Promise.all([
    incrementFixedWindowCounters({
      keys: keys.ip,
      maxAttempts: EMAIL_VERIFICATION_IP_MAX_FAILURES,
      windowSeconds: EMAIL_VERIFICATION_WINDOW_SECONDS,
      client,
    }),
    incrementFixedWindowCounters({
      keys: [keys.tokenIp, keys.user].filter(Boolean),
      maxAttempts: EMAIL_VERIFICATION_MAX_FAILURES,
      windowSeconds: EMAIL_VERIFICATION_WINDOW_SECONDS,
      client,
    }),
  ]);
  return mergeCounterStates(states);
}

export async function clearEmailVerificationFailures({
  req,
  tokenHash,
  userId,
  client,
  includeIp = false,
}) {
  const keys = getEmailVerificationKeys({ req, tokenHash, userId });
  return clearFixedWindowCounters(
    [includeIp ? keys.ip : null, keys.tokenIp, keys.user].filter(Boolean),
    client,
  );
}

export async function assertSensitiveTwoFactorActionAllowed({
  req,
  userId,
  action,
  client,
}) {
  const state = await getFixedWindowCounterState({
    keys: getSensitiveActionKeys({ req, userId, action }),
    maxAttempts: SENSITIVE_ACTION_MAX_FAILURES,
    client,
  });
  if (state.exhausted) {
    throw new SecurityLimitExceededError('TWO_FA_ACTION_RATE_LIMIT', state);
  }
  return state;
}

export async function reserveSensitiveTwoFactorActionAttempt({
  req,
  userId,
  action,
  client,
}) {
  const state = await incrementFixedWindowCounters({
    keys: getSensitiveActionKeys({ req, userId, action }),
    maxAttempts: SENSITIVE_ACTION_MAX_FAILURES,
    windowSeconds: SENSITIVE_ACTION_WINDOW_SECONDS,
    client,
  });
  return {
    ...state,
    attemptsLeft: Math.max(0, SENSITIVE_ACTION_MAX_FAILURES - state.attempts),
    limitReached: state.attempts >= SENSITIVE_ACTION_MAX_FAILURES,
    blocked: state.attempts > SENSITIVE_ACTION_MAX_FAILURES,
  };
}

export function clearSensitiveTwoFactorActionFailures({
  req,
  userId,
  action,
  client,
}) {
  return clearFixedWindowCounters(
    getSensitiveActionKeys({ req, userId, action }),
    client,
  );
}

export const AUTH_ATTEMPT_LIMITS = Object.freeze({
  EMAIL_VERIFICATION_MAX_FAILURES,
  EMAIL_VERIFICATION_IP_MAX_FAILURES,
  EMAIL_VERIFICATION_WINDOW_SECONDS,
  SENSITIVE_ACTION_MAX_FAILURES,
  SENSITIVE_ACTION_WINDOW_SECONDS,
});
