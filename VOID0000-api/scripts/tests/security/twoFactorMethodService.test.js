import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BACKUP_CODE_LOGIN_POLICY,
  buildAllowedTwoFactorMethods,
  isTwoFactorMethodAllowed,
  isTwoFactorMethodAuthorized,
  isTwoFactorMethodCurrentlyAvailable,
  loadAllowedTwoFactorMethods,
} from '../../../server/auth/services/twoFactorMethodService.js';

test('a TOTP-only challenge authorizes TOTP but not email', () => {
  const allowedMethods = buildAllowedTwoFactorMethods(['totp']);
  const challenge = { allowedMethods };

  assert.deepEqual(allowedMethods, ['totp']);
  assert.equal(isTwoFactorMethodAllowed(challenge, 'totp'), true);
  assert.equal(isTwoFactorMethodAllowed(challenge, 'email'), false);
});

test('an email-only challenge cannot select TOTP', () => {
  const challenge = {
    allowedMethods: buildAllowedTwoFactorMethods(['email']),
  };
  assert.equal(isTwoFactorMethodAllowed(challenge, 'email'), true);
  assert.equal(isTwoFactorMethodAllowed(challenge, 'totp'), false);
});

test('backup is authorized only when an unused code exists', () => {
  assert.equal(BACKUP_CODE_LOGIN_POLICY, 'unused-code-required');
  assert.deepEqual(buildAllowedTwoFactorMethods(['totp'], false), ['totp']);
  assert.deepEqual(buildAllowedTwoFactorMethods(['totp'], true), ['totp', 'backup']);
  assert.deepEqual(buildAllowedTwoFactorMethods([], true), []);
});

test('allowed methods are loaded from server-side configuration', async () => {
  const queryable = {
    async query(sql) {
      if (sql.includes('FROM user_2fa\n')) {
        return { rows: [{ method: 'totp' }] };
      }
      return { rows: [{ available: true }] };
    },
  };

  assert.deepEqual(
    await loadAllowedTwoFactorMethods(queryable, 'user-id'),
    ['totp', 'backup'],
  );
});

test('a method disabled after challenge creation is unavailable', async () => {
  const queryable = {
    async query() {
      return { rows: [{ available: false }] };
    },
  };

  assert.equal(
    await isTwoFactorMethodCurrentlyAvailable(queryable, 'user-id', 'email'),
    false,
  );
});

test('route authorization requires both challenge permission and current database state', async () => {
  const enabledQueryable = {
    async query() {
      return { rows: [{ available: true }] };
    },
  };
  const disabledQueryable = {
    async query() {
      return { rows: [{ available: false }] };
    },
  };
  const totpChallenge = { userId: 'user-id', allowedMethods: ['totp'] };

  assert.equal(
    await isTwoFactorMethodAuthorized(enabledQueryable, totpChallenge, 'email'),
    false,
  );
  assert.equal(
    await isTwoFactorMethodAuthorized(enabledQueryable, totpChallenge, 'totp'),
    true,
  );
  assert.equal(
    await isTwoFactorMethodAuthorized(disabledQueryable, totpChallenge, 'totp'),
    false,
  );
});
