import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';

import valkey from '../../../server/valkey.js';
import {
  checkTwoFactorBlocked,
  clearTwoFactorAttemptState,
  create2FASession,
  getPendingTwoFactorSession,
  recordTwoFactorFailure,
} from '../../../server/auth/services/twoFactorChallengeService.js';

after(async () => {
  await valkey.quit();
});

test('pending 2FA challenges persist only normalized authorized methods', async (t) => {
  const req = {
    cookies: { deviceId: `device-${crypto.randomUUID()}` },
    headers: {},
    ip: '127.0.0.1',
    get(name) {
      return name === 'User-Agent' ? 'two-factor-test' : '';
    },
  };
  const token = await create2FASession('test-user', req, [
    'totp',
    'totp',
    'attacker-controlled',
  ]);
  t.after(() => clearTwoFactorAttemptState(token));

  const challenge = await getPendingTwoFactorSession(token);
  assert.deepEqual(challenge.allowedMethods, ['totp']);
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
