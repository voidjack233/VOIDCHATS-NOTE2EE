import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';

import valkey from '../../../server/valkey.js';
import {
  checkTwoFactorBlocked,
  claimPendingTwoFactorSession,
  clearTwoFactorAttemptState,
  create2FASession,
  createTwoFactorClaimOwnerId,
  finalizeClaimedTwoFactorSession,
  getPendingTwoFactorSession,
  recordTwoFactorEmailSend,
  recordTwoFactorFailure,
  releaseClaimedTwoFactorSession,
  updatePendingTwoFactorSession,
} from '../../../server/auth/services/twoFactorChallengeService.js';
import {
  SecurityCounterUnavailableError,
} from '../../../server/auth/services/securityCounterService.js';

after(async () => {
  await valkey.quit();
});

function createRequest(deviceId = `device-${crypto.randomUUID()}`) {
  return {
    cookies: { deviceId },
    headers: {},
    ip: '127.0.0.1',
    get(name) {
      return name === 'User-Agent' ? 'two-factor-test' : '';
    },
  };
}

function getKeys(token) {
  return {
    session: `auth:2fa:session:${token}`,
    verify: `auth:2fa:verify:${token}`,
    email: `auth:2fa:email:${token}`,
  };
}

async function cleanupToken(token) {
  const keys = getKeys(token);
  await valkey.del(keys.session, keys.verify, keys.email);
}

test('pending 2FA challenges persist only normalized authorized methods', async (t) => {
  const token = await create2FASession('test-user', createRequest(), [
    'totp',
    'totp',
    'attacker-controlled',
  ]);
  t.after(() => cleanupToken(token));

  const challenge = await getPendingTwoFactorSession(token);
  assert.deepEqual(challenge.allowedMethods, ['totp']);
});

test('atomic pending 2FA updates preserve the existing challenge expiry', async (t) => {
  const token = await create2FASession('test-user', createRequest(), ['email']);
  const keys = getKeys(token);
  t.after(() => cleanupToken(token));
  const expectedSession = await getPendingTwoFactorSession(token);

  await valkey.pexpire(keys.session, 2_000);
  const updateStatus = await updatePendingTwoFactorSession(
    token,
    expectedSession,
    { ...expectedSession, emailCodeHash: 'updated-code-state' },
  );
  const remainingTtlMs = await valkey.pttl(keys.session);

  assert.equal(updateStatus, 'updated');
  assert.ok(remainingTtlMs > 0);
  assert.ok(remainingTtlMs <= 2_000);
});

test('twenty concurrent 2FA failures are counted without lost updates', async (t) => {
  const token = `test-${crypto.randomUUID()}`;
  t.after(() => cleanupToken(token));

  const states = await Promise.all(Array.from({ length: 20 }, () => (
    recordTwoFactorFailure(token)
  )));
  const blocked = await checkTwoFactorBlocked(token);

  assert.equal(Math.max(...states.map((state) => state.attempts)), 20);
  assert.equal(states.filter((state) => state.exhausted).length, 16);
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.retryAfterSeconds > 0);
});

test('concurrent claims have exactly one owner and preserve the authoritative snapshot', async (t) => {
  const token = await create2FASession('test-user', createRequest(), ['totp']);
  t.after(() => cleanupToken(token));
  const expectedSession = await getPendingTwoFactorSession(token);
  const owners = [createTwoFactorClaimOwnerId(), createTwoFactorClaimOwnerId()];

  const claims = await Promise.all(owners.map((claimOwnerId) => (
    claimPendingTwoFactorSession({
      twoFactorToken: token,
      expectedSession,
      claimOwnerId,
    })
  )));

  assert.equal(claims.filter(({ status }) => status === 'claimed').length, 1);
  assert.equal(claims.filter(({ status }) => status === 'busy').length, 1);
  assert.deepEqual(claims.find(({ status }) => status === 'claimed').session, expectedSession);
  assert.deepEqual(await getPendingTwoFactorSession(token), expectedSession);
});

test('release requires the claim owner and restores the exact session with remaining TTL', async (t) => {
  const token = await create2FASession('test-user', createRequest(), ['email']);
  const keys = getKeys(token);
  t.after(() => cleanupToken(token));
  const expectedSession = await getPendingTwoFactorSession(token);
  await valkey.pexpire(keys.session, 2_000);
  await recordTwoFactorFailure(token);
  await recordTwoFactorEmailSend(token);

  const owner = createTwoFactorClaimOwnerId();
  assert.equal((await claimPendingTwoFactorSession({
    twoFactorToken: token,
    expectedSession,
    claimOwnerId: owner,
  })).status, 'claimed');

  assert.equal(await releaseClaimedTwoFactorSession({
    twoFactorToken: token,
    claimOwnerId: createTwoFactorClaimOwnerId(),
  }), 'owner_mismatch');
  assert.equal(await finalizeClaimedTwoFactorSession({
    twoFactorToken: token,
    claimOwnerId: createTwoFactorClaimOwnerId(),
  }), 'owner_mismatch');
  assert.equal(await updatePendingTwoFactorSession(
    token,
    expectedSession,
    { ...expectedSession, changed: true },
  ), 'busy');
  assert.equal(await clearTwoFactorAttemptState(token), 'busy');

  assert.equal(await releaseClaimedTwoFactorSession({
    twoFactorToken: token,
    claimOwnerId: owner,
  }), 'released');
  assert.deepEqual(await getPendingTwoFactorSession(token), expectedSession);
  assert.ok(await valkey.pttl(keys.session) > 0);
  assert.ok(await valkey.pttl(keys.session) <= 2_000);
  assert.equal(await valkey.get(keys.verify), '1');
  assert.equal(await valkey.get(keys.email), '1');
});

test('finalization atomically deletes the challenge and both attempt counters once', async (t) => {
  const token = await create2FASession('test-user', createRequest(), ['totp']);
  const keys = getKeys(token);
  t.after(() => cleanupToken(token));
  const expectedSession = await getPendingTwoFactorSession(token);
  await recordTwoFactorFailure(token);
  await recordTwoFactorEmailSend(token);
  const owner = createTwoFactorClaimOwnerId();

  assert.equal((await claimPendingTwoFactorSession({
    twoFactorToken: token,
    expectedSession,
    claimOwnerId: owner,
  })).status, 'claimed');
  assert.equal(await finalizeClaimedTwoFactorSession({
    twoFactorToken: token,
    claimOwnerId: owner,
  }), 'finalized');
  assert.deepEqual(await valkey.mget(keys.session, keys.verify, keys.email), [
    null,
    null,
    null,
  ]);
  assert.equal(await finalizeClaimedTwoFactorSession({
    twoFactorToken: token,
    claimOwnerId: owner,
  }), 'missing');
});

test('a changed email snapshot cannot be claimed and remains pending', async (t) => {
  const token = await create2FASession('test-user', createRequest(), ['email']);
  t.after(() => cleanupToken(token));
  const original = await getPendingTwoFactorSession(token);
  const current = {
    ...original,
    emailCodeHash: crypto.randomBytes(32).toString('hex'),
    emailCodeExpiresAt: Date.now() + 60_000,
  };
  assert.equal(await updatePendingTwoFactorSession(token, original, current), 'updated');

  const claim = await claimPendingTwoFactorSession({
    twoFactorToken: token,
    expectedSession: original,
    claimOwnerId: createTwoFactorClaimOwnerId(),
  });

  assert.equal(claim.status, 'changed');
  assert.deepEqual(await getPendingTwoFactorSession(token), current);
});

test('an invalid attempt increments counters without claiming the challenge', async (t) => {
  const token = await create2FASession('test-user', createRequest(), ['totp']);
  const keys = getKeys(token);
  t.after(() => cleanupToken(token));

  const failureState = await recordTwoFactorFailure(token);
  const stored = JSON.parse(await valkey.get(keys.session));

  assert.equal(failureState.attempts, 1);
  assert.equal(stored.__voidTwoFactorState, undefined);
  assert.ok(await getPendingTwoFactorSession(token));
});

test('Valkey failures during claim, release, and finalization fail closed', async () => {
  const failingClient = {
    async eval() {
      throw new Error('valkey unavailable');
    },
  };
  const common = {
    twoFactorToken: `test-${crypto.randomUUID()}`,
    claimOwnerId: createTwoFactorClaimOwnerId(),
    client: failingClient,
  };

  await assert.rejects(
    claimPendingTwoFactorSession({
      ...common,
      expectedSession: { userId: 'test-user', expiresAt: Date.now() + 60_000 },
    }),
    SecurityCounterUnavailableError,
  );
  await assert.rejects(
    releaseClaimedTwoFactorSession(common),
    SecurityCounterUnavailableError,
  );
  await assert.rejects(
    finalizeClaimedTwoFactorSession(common),
    SecurityCounterUnavailableError,
  );
});
