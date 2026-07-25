import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAdminConfig } from '../../../../VOIDADMIN/adminConfig.js';

const strongPassword = 'correct-horse-battery-staple';

test('refuses missing and unsafe admin credentials', () => {
  assert.throws(() => resolveAdminConfig({}), /ADMIN_PANEL_USERNAME is required/);
  assert.throws(
    () => resolveAdminConfig({ ADMIN_PANEL_USERNAME: 'operator' }),
    /ADMIN_PANEL_PASSWORD is required/,
  );
  assert.throws(
    () => resolveAdminConfig({
      ADMIN_PANEL_USERNAME: 'admin',
      ADMIN_PANEL_PASSWORD: 'admin',
      NODE_ENV: 'development',
      ADMIN_PANEL_ALLOW_WEAK_PASSWORD: 'true',
    }),
    /Unsafe default admin credentials/,
  );
});

test('defaults configured admin access to loopback only', () => {
  const config = resolveAdminConfig({
    ADMIN_PANEL_USERNAME: 'operator',
    ADMIN_PANEL_PASSWORD: strongPassword,
    NODE_ENV: 'production',
  });

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4310);
});

test('allows weak passwords only through an explicit development override', () => {
  assert.throws(
    () => resolveAdminConfig({
      ADMIN_PANEL_USERNAME: 'operator',
      ADMIN_PANEL_PASSWORD: 'weak',
      NODE_ENV: 'development',
    }),
    /at least 16 characters/,
  );
  assert.throws(
    () => resolveAdminConfig({
      ADMIN_PANEL_USERNAME: 'operator',
      ADMIN_PANEL_PASSWORD: 'passwordpassword',
      NODE_ENV: 'production',
    }),
    /not obviously weak/,
  );
  assert.throws(
    () => resolveAdminConfig({
      ADMIN_PANEL_USERNAME: 'operator',
      ADMIN_PANEL_PASSWORD: '1234567890123456',
      NODE_ENV: 'production',
    }),
    /not obviously weak/,
  );

  const config = resolveAdminConfig({
    ADMIN_PANEL_USERNAME: 'operator',
    ADMIN_PANEL_PASSWORD: 'weak',
    NODE_ENV: 'development',
    ADMIN_PANEL_ALLOW_WEAK_PASSWORD: 'true',
  });
  assert.equal(config.password, 'weak');
});

test('requires explicit production opt-in for non-loopback binding', () => {
  assert.throws(
    () => resolveAdminConfig({
      ADMIN_PANEL_USERNAME: 'operator',
      ADMIN_PANEL_PASSWORD: strongPassword,
      ADMIN_PANEL_HOST: '0.0.0.0',
      NODE_ENV: 'production',
    }),
    /must use a loopback host/,
  );

  const config = resolveAdminConfig({
    ADMIN_PANEL_USERNAME: 'operator',
    ADMIN_PANEL_PASSWORD: strongPassword,
    ADMIN_PANEL_HOST: '0.0.0.0',
    ADMIN_PANEL_ALLOW_NON_LOOPBACK: 'true',
    NODE_ENV: 'production',
  });
  assert.equal(config.host, '0.0.0.0');
});
