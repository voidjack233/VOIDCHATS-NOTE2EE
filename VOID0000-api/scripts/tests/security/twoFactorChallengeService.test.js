import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';

import valkey from '../../../server/valkey.js';
import {
  claimVerifiedTwoFactorSession,
  checkTwoFactorBlocked,
  clearTwoFactorAttemptState,
  consumePendingTwoFactorSession,
  create2FASession,
  getPendingTwoFactorSession,
  recordTwoFactorFailure,
  updatePendingTwoFactorSession,
} from '../../../server/auth/services/twoFactorChallengeService.js';
import {
  SecurityCounterUnavailableError,
} from '../../../server/auth/services/securityCounterService.js';

after(async () => {
  await valkey.quit();
});

function createRequest() {
  return {
    cookies: { deviceId: `device-${crypto.randomUUID()}` },
    headers: {},
    ip: '127.0.0.1',
    get(name) {
      return name === 'User-Agent' ? 'two-factor-test' : '';
    },
  };
}

const enabledMethodQueryable = {
  async query() {
    return { rows: [{ available: true }] };
  },
};

test('pending 2FA challenges persist only normalized authorized methods', async (t) => {
  const req = createRequest();
  const token = await create2FASession('test-user', req, [
    'totp',
    'totp',
    'attacker-controlled',
  ]);
  t.after(() => clearTwoFactorAttemptState(token));

  const challenge = await getPendingTwoFactorSession(token);
  assert.deepEqual(challenge.allowedMethods, ['totp']);
});

test('atomic pending 2FA updates preserve the existing challenge expiry', async (t) => {
  const req = createRequest();
  const token = await create2FASession('test-user', req, ['email']);
  const sessionKey = `auth:2fa:session:${token}`;
  t.after(() => clearTwoFactorAttemptState(token));
  const expectedSession = await getPendingTwoFactorSession(token);

  await valkey.pexpire(sessionKey, 2_000);
  const updateStatus = await updatePendingTwoFactorSession(
    token,
    expectedSession,
    { ...expectedSession, emailCodeHash: 'updated-code-state' },
  );
  const remainingTtlMs = await valkey.pttl(sessionKey);

  assert.equal(updateStatus, 'updated');
  assert.ok(remainingTtlMs > 0);
  assert.ok(remainingTtlMs <= 2_000);
});

test('twenty concurrent 2FA failures are counted without lost updates', async (t) => {
  const token = `test-${crypto.randomUUID()}`;
  t.after(() => clearTwoFactorAttemptState(token));

  const states = await Promise.all(Array.from({ length: 20 }, () => (
    recordTwoFactorFailure(token)
  )));
  const blocked = await checkTwoFactorBlocked(token);

  assert.equal(Math.max(...states.map((state) => state.attempts)), 20);
  assert.equal(states.filter((state) => state.exhausted).length, 16);
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.retryAfterSeconds > 0);
});

test('one concurrent valid TOTP challenge creates exactly one login session', async (t) => {
  const req = createRequest();
  const token = await create2FASession('test-user', req, ['totp']);
  t.after(() => clearTwoFactorAttemptState(token));
  const expectedSession = await getPendingTwoFactorSession(token);
  let loginSessionCount = 0;

  const completeLogin = async () => {
    const claim = await claimVerifiedTwoFactorSession({
      twoFactorToken: token,
      expectedSession,
      method: 'totp',
      req,
      queryable: enabledMethodQueryable,
    });
    if (claim.status === 'consumed') {
      loginSessionCount += 1;
    }
    return claim.status;
  };

  const statuses = await Promise.all([completeLogin(), completeLogin()]);
  assert.equal(statuses.filter((status) => status === 'consumed').length, 1);
  assert.equal(statuses.filter((status) => status === 'missing').length, 1);
  assert.equal(loginSessionCount, 1);
});

test('one concurrent valid email challenge creates exactly one login session', async (t) => {
  const req = createRequest();
  const token = await create2FASession('test-user', req, ['email']);
  t.after(() => clearTwoFactorAttemptState(token));
  const initialSession = await getPendingTwoFactorSession(token);
  const verifiedEmailCodeHash = crypto.randomBytes(32).toString('hex');
  const expectedSession = {
    ...initialSession,
    emailCodeHash: verifiedEmailCodeHash,
    emailCodeExpiresAt: Date.now() + 60_000,
  };
  assert.equal(
    await updatePendingTwoFactorSession(token, initialSession, expectedSession),
    'updated',
  );
  let loginSessionCount = 0;

  const completeLogin = async () => {
    const claim = await claimVerifiedTwoFactorSession({
      twoFactorToken: token,
      expectedSession,
      method: 'email',
      req,
      queryable: enabledMethodQueryable,
      verifiedEmailCodeHash,
    });
    if (claim.status === 'consumed') {
      loginSessionCount += 1;
    }
    return claim.status;
  };

  const statuses = await Promise.all([completeLogin(), completeLogin()]);
  assert.equal(statuses.filter((status) => status === 'consumed').length, 1);
  assert.equal(statuses.filter((status) => status === 'missing').length, 1);
  assert.equal(loginSessionCount, 1);
});

test('a changed challenge snapshot is consumed but cannot create credentials', async (t) => {
  const req = createRequest();
  const token = await create2FASession('test-user', req, ['totp']);
  t.after(() => clearTwoFactorAttemptState(token));
  const expectedSession = await getPendingTwoFactorSession(token);
  const changedSession = { ...expectedSession, securityRevision: 2 };
  assert.equal(
    await updatePendingTwoFactorSession(token, expectedSession, changedSession),
    'updated',
  );

  const claim = await claimVerifiedTwoFactorSession({
    twoFactorToken: token,
    expectedSession,
    method: 'totp',
    req,
    queryable: enabledMethodQueryable,
  });

  assert.equal(claim.status, 'changed');
  assert.equal(await getPendingTwoFactorSession(token), null);
});

test('changed email-code state is rejected after atomic challenge consumption', async (t) => {
  const req = createRequest();
  const token = await create2FASession('test-user', req, ['email']);
  t.after(() => clearTwoFactorAttemptState(token));
  const initialSession = await getPendingTwoFactorSession(token);
  const verifiedEmailCodeHash = crypto.randomBytes(32).toString('hex');
  const expectedSession = {
    ...initialSession,
    emailCodeHash: verifiedEmailCodeHash,
    emailCodeExpiresAt: Date.now() + 60_000,
  };
  assert.equal(
    await updatePendingTwoFactorSession(token, initialSession, expectedSession),
    'updated',
  );
  const changedSession = {
    ...expectedSession,
    emailCodeHash: crypto.randomBytes(32).toString('hex'),
  };
  assert.equal(
    await updatePendingTwoFactorSession(token, expectedSession, changedSession),
    'updated',
  );

  const claim = await claimVerifiedTwoFactorSession({
    twoFactorToken: token,
    expectedSession,
    method: 'email',
    req,
    queryable: enabledMethodQueryable,
    verifiedEmailCodeHash,
  });

  assert.equal(claim.status, 'changed');
  assert.equal(await getPendingTwoFactorSession(token), null);
});

test('an invalid attempt increments counters without consuming the challenge', async (t) => {
  const req = createRequest();
  const token = await create2FASession('test-user', req, ['totp']);
  t.after(() => clearTwoFactorAttemptState(token));

  const failureState = await recordTwoFactorFailure(token);

  assert.equal(failureState.attempts, 1);
  assert.ok(await getPendingTwoFactorSession(token));
});

test('Valkey failure during challenge consumption creates no login session', async () => {
  const req = createRequest();
  const expectedSession = {
    userId: 'test-user',
    allowedMethods: ['totp'],
    deviceFingerprint: 'unused',
    userAgent: 'two-factor-test',
    expiresAt: Date.now() + 60_000,
  };
  const failingClient = {
    async eval() {
      throw new Error('valkey unavailable');
    },
  };
  let loginSessionCount = 0;

  await assert.rejects(
    claimVerifiedTwoFactorSession({
      twoFactorToken: `test-${crypto.randomUUID()}`,
      expectedSession,
      method: 'totp',
      req,
      queryable: enabledMethodQueryable,
      client: failingClient,
    }).then(() => {
      loginSessionCount += 1;
    }),
    SecurityCounterUnavailableError,
  );
  assert.equal(loginSessionCount, 0);
});

test('email session updates cannot resurrect an already consumed challenge', async (t) => {
  const req = createRequest();
  const token = await create2FASession('test-user', req, ['email']);
  t.after(() => clearTwoFactorAttemptState(token));
  const expectedSession = await getPendingTwoFactorSession(token);
  const consumedSession = await consumePendingTwoFactorSession(token);
  assert.ok(consumedSession);

  const updateStatus = await updatePendingTwoFactorSession(
    token,
    expectedSession,
    { ...expectedSession, emailCodeHash: 'new-code-state' },
  );

  assert.equal(updateStatus, 'missing');
  assert.equal(await getPendingTwoFactorSession(token), null);
});
