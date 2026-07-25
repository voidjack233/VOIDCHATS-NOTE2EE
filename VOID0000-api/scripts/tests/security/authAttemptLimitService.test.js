import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';

import valkey from '../../../server/valkey.js';
import {
  AUTH_ATTEMPT_LIMITS,
  SecurityLimitExceededError,
  assertEmailVerificationAllowed,
  assertSensitiveTwoFactorActionAllowed,
  clearEmailVerificationFailures,
  clearSensitiveTwoFactorActionFailures,
  recordEmailVerificationFailure,
  reserveSensitiveTwoFactorActionAttempt,
} from '../../../server/auth/services/authAttemptLimitService.js';
import { SecurityCounterUnavailableError } from '../../../server/auth/services/securityCounterService.js';

after(async () => {
  await valkey.quit();
});

function createRequest() {
  const ip = `203.0.113.${crypto.randomInt(1, 255)}`;
  return {
    cookies: { deviceId: `device-${crypto.randomUUID()}` },
    headers: { 'cf-connecting-ip': ip },
    ip,
    get(name) {
      return name === 'User-Agent' ? 'security-test' : '';
    },
  };
}

test('parallel invalid email verification attempts cannot bypass the budget', async (t) => {
  const req = createRequest();
  const tokenHash = crypto.randomBytes(32).toString('hex');
  const userId = crypto.randomUUID();
  t.after(() => clearEmailVerificationFailures({
    req,
    tokenHash,
    userId,
    includeIp: true,
  }));

  const states = await Promise.all(
    Array.from({ length: 20 }, () => recordEmailVerificationFailure({
      req,
      tokenHash,
      userId,
    })),
  );

  assert.equal(Math.max(...states.map((state) => state.attempts)), 20);
  assert.equal(
    states.filter((state) => state.exhausted).length,
    20 - AUTH_ATTEMPT_LIMITS.EMAIL_VERIFICATION_MAX_FAILURES + 1,
  );
  await assert.rejects(
    assertEmailVerificationAllowed({ req, tokenHash, userId }),
    SecurityLimitExceededError,
  );
});

test('successful email verification clears token and user failure state', async (t) => {
  const req = createRequest();
  const tokenHash = crypto.randomBytes(32).toString('hex');
  const userId = crypto.randomUUID();
  t.after(() => clearEmailVerificationFailures({
    req,
    tokenHash,
    userId,
    includeIp: true,
  }));

  await recordEmailVerificationFailure({ req, tokenHash, userId });
  await clearEmailVerificationFailures({ req, tokenHash, userId });
  const state = await assertEmailVerificationAllowed({ req, tokenHash, userId });

  assert.equal(state.exhausted, false);
  assert.equal(state.attempts, 1);
});

test('parallel wrong passwords cannot bypass a sensitive 2FA action limit', async (t) => {
  const req = createRequest();
  const userId = crypto.randomUUID();
  const action = 'setup_totp';
  t.after(() => clearSensitiveTwoFactorActionFailures({ req, userId, action }));

  const states = await Promise.all(
    Array.from({ length: 20 }, () => reserveSensitiveTwoFactorActionAttempt({
      req,
      userId,
      action,
    })),
  );

  assert.equal(Math.max(...states.map((state) => state.attempts)), 20);
  assert.equal(states.filter((state) => !state.blocked).length, 5);
  assert.equal(states.filter((state) => state.blocked).length, 15);
  await assert.rejects(
    assertSensitiveTwoFactorActionAllowed({ req, userId, action }),
    SecurityLimitExceededError,
  );
});

test('successful password validation clears the sensitive action budget', async (t) => {
  const req = createRequest();
  const userId = crypto.randomUUID();
  const action = 'disable';
  t.after(() => clearSensitiveTwoFactorActionFailures({ req, userId, action }));

  await reserveSensitiveTwoFactorActionAttempt({ req, userId, action });
  await clearSensitiveTwoFactorActionFailures({ req, userId, action });
  const state = await assertSensitiveTwoFactorActionAllowed({ req, userId, action });

  assert.equal(state.attempts, 0);
  assert.equal(state.exhausted, false);
});

test('the valid-password path remains available before the failure threshold', async (t) => {
  const req = createRequest();
  const userId = crypto.randomUUID();
  const action = 'setup_email';
  t.after(() => clearSensitiveTwoFactorActionFailures({ req, userId, action }));

  for (let attempt = 0; attempt < AUTH_ATTEMPT_LIMITS.SENSITIVE_ACTION_MAX_FAILURES - 1; attempt += 1) {
    await reserveSensitiveTwoFactorActionAttempt({ req, userId, action });
  }

  const state = await assertSensitiveTwoFactorActionAllowed({ req, userId, action });
  assert.equal(state.exhausted, false);
  assert.equal(state.attemptsLeft, 1);
});

test('attempt-limit backend errors fail closed', async () => {
  const req = createRequest();
  const failingClient = {
    async eval() {
      throw new Error('valkey unavailable');
    },
  };

  await assert.rejects(
    assertSensitiveTwoFactorActionAllowed({
      req,
      userId: crypto.randomUUID(),
      action: 'disable',
      client: failingClient,
    }),
    SecurityCounterUnavailableError,
  );
});
