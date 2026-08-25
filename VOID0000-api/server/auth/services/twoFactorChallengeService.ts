import crypto from 'crypto';
import type { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import valkey from '../../valkey.js';
import { DeviceFingerprint } from '../../utils/deviceFingerprint.js';
import { getClientIP } from '../../utils/securityUtils.js';
import { getTwoFactorCodeSecret } from '../config/authSecrets.js';
import {
  buildAllowedTwoFactorMethods,
} from './twoFactorMethodService.js';
import {
  SecurityCounterUnavailableError,
  getFixedWindowCounterState,
  incrementFixedWindowCounters,
} from './securityCounterService.js';
import type { SecurityCounterClient } from './securityCounterService.js';
import type { PendingTwoFactorSession } from '../types.js';

const TWO_FACTOR_VERIFY_WINDOW_SEC = 5 * 60;
const TWO_FACTOR_VERIFY_MAX_ATTEMPTS = 5;
const TWO_FACTOR_EMAIL_WINDOW_SEC = 10 * 60;
const TWO_FACTOR_EMAIL_MAX_SENDS = 3;
const TWO_FACTOR_SESSION_WINDOW_SEC = 5 * 60;

interface RequestBinding {
  deviceFingerprint: string;
  userAgent: string;
}

interface ClaimResult {
  status: string;
  session: PendingTwoFactorSession | null;
  ttlMilliseconds: number;
}

interface UpdatePendingSessionOptions {
  client?: SecurityCounterClient;
}

interface ClaimPendingSessionOptions extends UpdatePendingSessionOptions {
  twoFactorToken: string;
  expectedSession: PendingTwoFactorSession;
  claimOwnerId: string;
  now?: number;
}

interface OwnedClaimOptions extends UpdatePendingSessionOptions {
  twoFactorToken: string;
  claimOwnerId: string;
}

function isPendingTwoFactorSession(
  value: unknown,
): value is PendingTwoFactorSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    'userId' in value &&
    typeof value.userId === 'string' &&
    'allowedMethods' in value &&
    Array.isArray(value.allowedMethods) &&
    value.allowedMethods.every(
      (method) => method === 'totp' || method === 'email' || method === 'backup',
    )
  );
}

function parsePendingTwoFactorSession(
  serialized: string,
): PendingTwoFactorSession | null {
  const parsed: unknown = JSON.parse(serialized);
  return isPendingTwoFactorSession(parsed) ? parsed : null;
}

// Claims retain only the challenge's original TTL. Expiry removes a stuck
// claim instead of reopening it, so crash recovery favors safety over reuse.
const CLAIM_PENDING_TWO_FACTOR_SESSION_SCRIPT = `
local session = redis.call('GET', KEYS[1])
if not session then
  return {'missing'}
end

local ok, decoded = pcall(cjson.decode, session)
if not ok or type(decoded) ~= 'table' then
  return {'changed'}
end
if decoded['__voidTwoFactorState'] == 'claimed' then
  return {'busy'}
end
if session ~= ARGV[1] then
  return {'changed'}
end

local nowMilliseconds = tonumber(ARGV[3])
local expiresAt = tonumber(decoded['expiresAt'])
local ttlMilliseconds = redis.call('PTTL', KEYS[1])
if not nowMilliseconds or not expiresAt or ttlMilliseconds <= 0 or nowMilliseconds > expiresAt then
  redis.call('DEL', KEYS[1])
  return {'missing'}
end

local remainingBySnapshot = expiresAt - nowMilliseconds
ttlMilliseconds = math.min(ttlMilliseconds, remainingBySnapshot)
if ttlMilliseconds <= 0 then
  redis.call('DEL', KEYS[1])
  return {'missing'}
end

local claimedEnvelope = cjson.encode({
  __voidTwoFactorState = 'claimed',
  claimOwnerId = ARGV[2],
  sessionSnapshot = session
})
redis.call('SET', KEYS[1], claimedEnvelope, 'PX', ttlMilliseconds)

return {'claimed', session, tostring(ttlMilliseconds)}
`;

const FINALIZE_CLAIMED_TWO_FACTOR_SESSION_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 'missing'
end

local ok, envelope = pcall(cjson.decode, current)
if not ok or type(envelope) ~= 'table' or envelope['__voidTwoFactorState'] ~= 'claimed' then
  return 'not_claimed'
end
if envelope['claimOwnerId'] ~= ARGV[1] then
  return 'owner_mismatch'
end

redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return 'finalized'
`;

const RELEASE_CLAIMED_TWO_FACTOR_SESSION_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 'missing'
end

local ok, envelope = pcall(cjson.decode, current)
if not ok or type(envelope) ~= 'table' or envelope['__voidTwoFactorState'] ~= 'claimed' then
  return 'not_claimed'
end
if envelope['claimOwnerId'] ~= ARGV[1] then
  return 'owner_mismatch'
end

local ttlMilliseconds = redis.call('PTTL', KEYS[1])
local sessionSnapshot = envelope['sessionSnapshot']
if ttlMilliseconds <= 0 or type(sessionSnapshot) ~= 'string' then
  redis.call('DEL', KEYS[1])
  return 'missing'
end

redis.call('SET', KEYS[1], sessionSnapshot, 'PX', ttlMilliseconds)
return 'released'
`;

const UPDATE_PENDING_TWO_FACTOR_SESSION_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 'missing'
end

local ok, decoded = pcall(cjson.decode, current)
if not ok or type(decoded) ~= 'table' then
  return 'changed'
end
if decoded['__voidTwoFactorState'] == 'claimed' then
  return 'busy'
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

const DELETE_PENDING_TWO_FACTOR_SESSION_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 'missing'
end

local ok, decoded = pcall(cjson.decode, current)
if not ok or type(decoded) ~= 'table' then
  return 'changed'
end
if decoded['__voidTwoFactorState'] == 'claimed' then
  return 'busy'
end

redis.call('DEL', KEYS[1])
return 'deleted'
`;

const CLEAR_TWO_FACTOR_ATTEMPT_STATE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if not ok or type(decoded) ~= 'table' then
    return 'changed'
  end
  if decoded['__voidTwoFactorState'] == 'claimed' then
    return 'busy'
  end
end

redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return 'cleared'
`;

function getTwoFactorSessionKey(twoFactorToken: string): string {
  return `auth:2fa:session:${twoFactorToken}`;
}

function getRequestBinding(req: Request): RequestBinding {
  return {
    deviceFingerprint: DeviceFingerprint.generateFingerprint(req),
    userAgent: req.get('User-Agent') || 'unknown',
  };
}

export function isSameRequestBinding(
  session: Partial<PendingTwoFactorSession> | null | undefined,
  req: Request,
): boolean {
  const current = getRequestBinding(req);
  return (
    session?.deviceFingerprint === current.deviceFingerprint &&
    session?.userAgent === current.userAgent
  );
}

export function generateEmailCode(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export function hashEmailCode(twoFactorToken: string, code: unknown): string {
  return crypto
    .createHmac('sha256', getTwoFactorCodeSecret())
    .update(`${twoFactorToken}:${String(code).trim()}`)
    .digest('hex');
}

export async function getPendingTwoFactorSession(
  twoFactorToken: string,
): Promise<PendingTwoFactorSession | null> {
  const raw = await valkey.get(getTwoFactorSessionKey(twoFactorToken));
  if (!raw) return null;

  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    '__voidTwoFactorState' in parsed &&
    parsed.__voidTwoFactorState === 'claimed' &&
    'sessionSnapshot' in parsed &&
    typeof parsed.sessionSnapshot === 'string'
  ) {
    return parsePendingTwoFactorSession(parsed.sessionSnapshot);
  }
  return isPendingTwoFactorSession(parsed) ? parsed : null;
}

export async function savePendingTwoFactorSession(
  twoFactorToken: string,
  session: PendingTwoFactorSession,
): Promise<void> {
  await valkey.set(
    getTwoFactorSessionKey(twoFactorToken),
    JSON.stringify(session),
    'EX',
    TWO_FACTOR_SESSION_WINDOW_SEC,
  );
}

export async function updatePendingTwoFactorSession(
  twoFactorToken: string,
  expectedSession: PendingTwoFactorSession,
  nextSession: PendingTwoFactorSession,
  client: SecurityCounterClient = valkey,
): Promise<string> {
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

export async function deletePendingTwoFactorSession(
  twoFactorToken: string,
  client: SecurityCounterClient = valkey,
): Promise<string> {
  try {
    return String(await client.eval(
      DELETE_PENDING_TWO_FACTOR_SESSION_SCRIPT,
      1,
      getTwoFactorSessionKey(twoFactorToken),
    ));
  } catch (error) {
    throw wrapSecurityOperationError(error);
  }
}

function parseClaimResult(result: unknown): ClaimResult {
  const values = Array.isArray(result) ? result : [];
  const status = String(values[0] || '');
  if (status !== 'claimed') {
    return { status, session: null, ttlMilliseconds: 0 };
  }

  try {
    const session = parsePendingTwoFactorSession(String(values[1] || ''));
    const ttlMilliseconds = Math.max(0, Number(values[2]) || 0);
    if (!session || ttlMilliseconds <= 0) {
      return { status: 'changed', session: null, ttlMilliseconds: 0 };
    }
    return { status, session, ttlMilliseconds };
  } catch {
    return { status: 'changed', session: null, ttlMilliseconds: 0 };
  }
}

function wrapSecurityOperationError(
  error: unknown,
): SecurityCounterUnavailableError {
  if (error instanceof SecurityCounterUnavailableError) return error;
  return new SecurityCounterUnavailableError(error);
}

export function createTwoFactorClaimOwnerId(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function claimPendingTwoFactorSession({
  twoFactorToken,
  expectedSession,
  claimOwnerId,
  client = valkey,
  now = Date.now(),
}: ClaimPendingSessionOptions): Promise<ClaimResult> {
  if (!twoFactorToken || !expectedSession || !claimOwnerId) {
    throw new TypeError('Two-factor token, expected session, and claim owner are required');
  }

  try {
    const result = await client.eval(
      CLAIM_PENDING_TWO_FACTOR_SESSION_SCRIPT,
      1,
      getTwoFactorSessionKey(twoFactorToken),
      JSON.stringify(expectedSession),
      claimOwnerId,
      String(now),
    );
    return parseClaimResult(result);
  } catch (error) {
    throw wrapSecurityOperationError(error);
  }
}

export async function finalizeClaimedTwoFactorSession({
  twoFactorToken,
  claimOwnerId,
  client = valkey,
}: OwnedClaimOptions): Promise<string> {
  if (!twoFactorToken || !claimOwnerId) {
    throw new TypeError('Two-factor token and claim owner are required');
  }

  try {
    return String(await client.eval(
      FINALIZE_CLAIMED_TWO_FACTOR_SESSION_SCRIPT,
      3,
      getTwoFactorSessionKey(twoFactorToken),
      getTwoFactorVerifyKey(twoFactorToken),
      getTwoFactorEmailKey(twoFactorToken),
      claimOwnerId,
    ));
  } catch (error) {
    throw wrapSecurityOperationError(error);
  }
}

export async function releaseClaimedTwoFactorSession({
  twoFactorToken,
  claimOwnerId,
  client = valkey,
}: OwnedClaimOptions): Promise<string> {
  if (!twoFactorToken || !claimOwnerId) {
    throw new TypeError('Two-factor token and claim owner are required');
  }

  try {
    return String(await client.eval(
      RELEASE_CLAIMED_TWO_FACTOR_SESSION_SCRIPT,
      1,
      getTwoFactorSessionKey(twoFactorToken),
      claimOwnerId,
    ));
  } catch (error) {
    throw wrapSecurityOperationError(error);
  }
}

export async function create2FASession(
  userId: string,
  req: Request,
  allowedMethods: unknown,
): Promise<string> {
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

function getTwoFactorVerifyKey(twoFactorToken: string): string {
  return `auth:2fa:verify:${twoFactorToken}`;
}

function getTwoFactorEmailKey(twoFactorToken: string): string {
  return `auth:2fa:email:${twoFactorToken}`;
}

export async function clearTwoFactorAttemptState(
  twoFactorToken: string,
  client: SecurityCounterClient = valkey,
): Promise<string> {
  try {
    return String(await client.eval(
      CLEAR_TWO_FACTOR_ATTEMPT_STATE_SCRIPT,
      3,
      getTwoFactorSessionKey(twoFactorToken),
      getTwoFactorVerifyKey(twoFactorToken),
      getTwoFactorEmailKey(twoFactorToken),
    ));
  } catch (error) {
    throw wrapSecurityOperationError(error);
  }
}

export async function recordTwoFactorFailure(twoFactorToken: string) {
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

export async function checkTwoFactorBlocked(twoFactorToken: string) {
  const state = await getFixedWindowCounterState({
    keys: getTwoFactorVerifyKey(twoFactorToken),
    maxAttempts: TWO_FACTOR_VERIFY_MAX_ATTEMPTS,
  });
  return {
    blocked: state.exhausted,
    retryAfterSeconds: state.retryAfterSeconds,
  };
}

export async function recordTwoFactorEmailSend(
  twoFactorToken: string,
): Promise<number> {
  const state = await incrementFixedWindowCounters({
    keys: getTwoFactorEmailKey(twoFactorToken),
    maxAttempts: TWO_FACTOR_EMAIL_MAX_SENDS + 1,
    windowSeconds: TWO_FACTOR_EMAIL_WINDOW_SEC,
  });
  return state.attempts;
}

export function hasExceededTwoFactorEmailSends(count: number): boolean {
  return count > TWO_FACTOR_EMAIL_MAX_SENDS;
}

export async function getTwoFactorEmailRetryAfter(
  twoFactorToken: string,
): Promise<number> {
  const state = await getFixedWindowCounterState({
    keys: getTwoFactorEmailKey(twoFactorToken),
    maxAttempts: TWO_FACTOR_EMAIL_MAX_SENDS + 1,
  });
  return state.retryAfterSeconds || TWO_FACTOR_EMAIL_WINDOW_SEC;
}
