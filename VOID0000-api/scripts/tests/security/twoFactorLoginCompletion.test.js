import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after, before } from 'node:test';

import argon2 from 'argon2';

import { pool } from '../../../server/db.js';
import valkey from '../../../server/valkey.js';
import {
  createVerifyLoginHandler,
} from '../../../server/auth/routes/twoFactor/verify-login.js';
import {
  create2FASession,
  getPendingTwoFactorSession,
  hashEmailCode,
  recordTwoFactorEmailSend,
  recordTwoFactorFailure,
  updatePendingTwoFactorSession,
} from '../../../server/auth/services/twoFactorChallengeService.js';
import { totp } from '../../../server/auth/services/totpService.js';
import { encrypt } from '../../../server/auth/services/twoFactorService.js';

const schema = `test_2fa_completion_${crypto.randomBytes(6).toString('hex')}`;
const quotedSchema = `"${schema}"`;
const trackedTokens = new Set();

function getChallengeKeys(token) {
  return [
    `auth:2fa:session:${token}`,
    `auth:2fa:verify:${token}`,
    `auth:2fa:email:${token}`,
  ];
}

async function cleanupChallenge(token) {
  await valkey.del(...getChallengeKeys(token));
  trackedTokens.delete(token);
}

const databasePool = {
  async query(sql, values) {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quotedSchema}, public`);
      return await client.query(sql, values);
    } finally {
      client.release();
    }
  },
  async connect() {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quotedSchema}, public`);
      return client;
    } catch (error) {
      client.release(true);
      throw error;
    }
  },
};

before(async () => {
  await pool.query(`CREATE SCHEMA ${quotedSchema}`);
  await pool.query(`
    CREATE TABLE ${quotedSchema}.users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      username TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      is_verified BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE ${quotedSchema}.user_2fa (
      user_id TEXT NOT NULL,
      method TEXT NOT NULL,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      totp_secret TEXT
    );

    CREATE TABLE ${quotedSchema}.user_2fa_backup_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      is_used BOOLEAN NOT NULL DEFAULT FALSE,
      used_at TIMESTAMPTZ
    );

    CREATE TABLE ${quotedSchema}.test_login_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
});

after(async () => {
  for (const token of trackedTokens) {
    await cleanupChallenge(token);
  }
  await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
  await Promise.allSettled([valkey.quit(), pool.end()]);
});

function createRequest(deviceId = `device-${crypto.randomUUID()}`) {
  const headers = {
    'user-agent': 'two-factor-route-test',
  };
  return {
    body: {},
    cookies: { deviceId },
    headers,
    ip: '127.0.0.1',
    path: '/api/auth/2fa/verify-login',
    socket: { remoteAddress: '127.0.0.1' },
    get(name) {
      return headers[String(name).toLowerCase()] || '';
    },
  };
}

function withVerificationBody(baseRequest, { token, code, method }) {
  return {
    ...baseRequest,
    body: {
      twoFactorToken: token,
      code,
      method,
    },
    cookies: { ...baseRequest.cookies },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: new Map(),
    cookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    set(name, value) {
      this.headers.set(name, value);
      return this;
    },
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
      return this;
    },
  };
}

async function createUser({ method, backupCode = null }) {
  const userId = crypto.randomUUID();
  const secret = method === 'totp' || method === 'backup'
    ? totp.generateSecret()
    : null;
  await databasePool.query(
    `INSERT INTO users (id, email, username, profile_id, is_verified)
     VALUES ($1, $2, $3, $4, true)`,
    [userId, `${userId}@example.test`, `user-${userId}`, crypto.randomUUID()],
  );
  await databasePool.query(
    `INSERT INTO user_2fa (user_id, method, is_enabled, totp_secret)
     VALUES ($1, $2, true, $3)`,
    [
      userId,
      method === 'email' ? 'email' : 'totp',
      secret ? encrypt(secret) : null,
    ],
  );

  let backupCodeId = null;
  if (method === 'backup') {
    backupCodeId = crypto.randomUUID();
    await databasePool.query(
      `INSERT INTO user_2fa_backup_codes (id, user_id, code_hash)
       VALUES ($1, $2, $3)`,
      [backupCodeId, userId, await argon2.hash(backupCode)],
    );
  }

  return { userId, secret, backupCodeId };
}

async function createTotpChallenge(userId, secret, req) {
  const token = await create2FASession(userId, req, ['totp']);
  trackedTokens.add(token);
  return { token, code: totp.generateToken(secret) };
}

async function createEmailChallenge(userId, req, code = '123456') {
  const token = await create2FASession(userId, req, ['email']);
  trackedTokens.add(token);
  const current = await getPendingTwoFactorSession(token);
  assert.equal(await updatePendingTwoFactorSession(token, current, {
    ...current,
    emailCodeHash: hashEmailCode(token, code),
    emailCodeExpiresAt: Date.now() + 60_000,
  }), 'updated');
  return { token, code };
}

async function createBackupChallenge(userId, req, code) {
  const token = await create2FASession(userId, req, ['totp', 'backup']);
  trackedTokens.add(token);
  return { token, code };
}

async function persistLoginSession({ queryable, user, req }) {
  await queryable.query(
    'INSERT INTO test_login_sessions (user_id) VALUES ($1)',
    [user.id],
  );
  return {
    userId: user.id,
    deviceId: req.cookies.deviceId,
    deviceInfo: {
      deviceName: 'Test Browser',
      deviceType: 'desktop',
    },
    userIp: req.ip,
    userAgent: req.get('User-Agent'),
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
  };
}

function buildHandler(overrides = {}) {
  return createVerifyLoginHandler({
    databasePool,
    createSessionRecord: persistLoginSession,
    activateSession: async () => {},
    setSessionCookies: () => {},
    recordLoginSuccess: async () => {},
    recordLoginTrust: async () => {},
    ...overrides,
  });
}

async function invoke(handler, request) {
  const response = createResponse();
  await handler(request, response);
  return response;
}

async function countLoginSessions(userId) {
  const result = await databasePool.query(
    'SELECT COUNT(*)::integer AS count FROM test_login_sessions WHERE user_id = $1',
    [userId],
  );
  return result.rows[0].count;
}

async function getRawChallenge(token) {
  const raw = await valkey.get(getChallengeKeys(token)[0]);
  return raw ? JSON.parse(raw) : null;
}

async function assertPendingAndUnclaimed(token) {
  const raw = await getRawChallenge(token);
  assert.ok(raw);
  assert.equal(raw.__voidTwoFactorState, undefined);
  assert.ok(await valkey.pttl(getChallengeKeys(token)[0]) > 0);
}

test('two simultaneous valid TOTP requests create exactly one durable login session', async (t) => {
  const req = createRequest();
  const { userId, secret } = await createUser({ method: 'totp' });
  const { token, code } = await createTotpChallenge(userId, secret, req);
  t.after(() => cleanupChallenge(token));
  await recordTwoFactorFailure(token);
  await recordTwoFactorEmailSend(token);
  const handler = buildHandler();
  const request = withVerificationBody(req, { token, code, method: 'totp' });

  const responses = await Promise.all([
    invoke(handler, request),
    invoke(handler, withVerificationBody(req, { token, code, method: 'totp' })),
  ]);

  assert.equal(responses.filter(({ statusCode }) => statusCode === 200).length, 1);
  assert.equal(responses.filter(({ statusCode }) => statusCode !== 200).length, 1);
  assert.equal(await countLoginSessions(userId), 1);
  assert.deepEqual(await valkey.mget(...getChallengeKeys(token)), [null, null, null]);

  const replay = await invoke(
    handler,
    withVerificationBody(req, { token, code, method: 'totp' }),
  );
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.body.code, 'TWO_FA_SESSION_USED');
});

test('two simultaneous valid email requests create exactly one durable login session', async (t) => {
  const req = createRequest();
  const { userId } = await createUser({ method: 'email' });
  const { token, code } = await createEmailChallenge(userId, req);
  t.after(() => cleanupChallenge(token));
  const handler = buildHandler();

  const responses = await Promise.all([
    invoke(handler, withVerificationBody(req, { token, code, method: 'email' })),
    invoke(handler, withVerificationBody(req, { token, code, method: 'email' })),
  ]);

  assert.equal(responses.filter(({ statusCode }) => statusCode === 200).length, 1);
  assert.equal(responses.filter(({ statusCode }) => statusCode !== 200).length, 1);
  assert.equal(await countLoginSessions(userId), 1);
});

test('pool acquisition and BEGIN failures leave the challenge usable', async (t) => {
  const req = createRequest();
  const { userId } = await createUser({ method: 'email' });
  const first = await createEmailChallenge(userId, req, '111111');
  const second = await createEmailChallenge(userId, req, '222222');
  t.after(() => Promise.all([
    cleanupChallenge(first.token),
    cleanupChallenge(second.token),
  ]));

  const poolFailureHandler = buildHandler({
    databasePool: {
      query: (...args) => databasePool.query(...args),
      async connect() {
        throw new Error('pool unavailable');
      },
    },
  });
  const poolFailure = await invoke(
    poolFailureHandler,
    withVerificationBody(req, { ...first, method: 'email' }),
  );
  assert.equal(poolFailure.statusCode, 503);
  await assertPendingAndUnclaimed(first.token);

  let releasedWithDestroy = false;
  const beginFailureHandler = buildHandler({
    databasePool: {
      query: (...args) => databasePool.query(...args),
      async connect() {
        return {
          async query(sql) {
            assert.equal(sql, 'BEGIN');
            throw new Error('BEGIN failed');
          },
          release(destroy) {
            releasedWithDestroy = destroy === true;
          },
        };
      },
    },
  });
  const beginFailure = await invoke(
    beginFailureHandler,
    withVerificationBody(req, { ...second, method: 'email' }),
  );
  assert.equal(beginFailure.statusCode, 503);
  assert.equal(releasedWithDestroy, true);
  await assertPendingAndUnclaimed(second.token);

  assert.equal((await invoke(
    buildHandler(),
    withVerificationBody(req, { ...first, method: 'email' }),
  )).statusCode, 200);
  assert.equal((await invoke(
    buildHandler(),
    withVerificationBody(req, { ...second, method: 'email' }),
  )).statusCode, 200);
  assert.equal(await countLoginSessions(userId), 2);
});

test('session insert failure rolls back and releases the claim for a successful retry', async (t) => {
  const req = createRequest();
  const { userId } = await createUser({ method: 'email' });
  const challenge = await createEmailChallenge(userId, req, '333333');
  t.after(() => cleanupChallenge(challenge.token));
  const failingHandler = buildHandler({
    async createSessionRecord({ queryable, user }) {
      await queryable.query(
        'INSERT INTO test_login_sessions (user_id) VALUES ($1)',
        [user.id],
      );
      throw new Error('session insert completion failed');
    },
  });

  const failed = await invoke(
    failingHandler,
    withVerificationBody(req, { ...challenge, method: 'email' }),
  );

  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.retryable, true);
  assert.equal(await countLoginSessions(userId), 0);
  await assertPendingAndUnclaimed(challenge.token);

  assert.equal((await invoke(
    buildHandler(),
    withVerificationBody(req, { ...challenge, method: 'email' }),
  )).statusCode, 200);
  assert.equal(await countLoginSessions(userId), 1);
});

test('backup-code consumption rolls back with the transaction and can be retried once', async (t) => {
  const req = createRequest();
  const backupCode = 'ABCD1234';
  const { userId, backupCodeId } = await createUser({ method: 'backup', backupCode });
  const challenge = await createBackupChallenge(userId, req, backupCode);
  t.after(() => cleanupChallenge(challenge.token));
  const failingHandler = buildHandler({
    async createSessionRecord() {
      throw new Error('session insert failed after backup consumption');
    },
  });

  const failed = await invoke(
    failingHandler,
    withVerificationBody(req, { ...challenge, method: 'backup' }),
  );
  const afterRollback = await databasePool.query(
    'SELECT is_used FROM user_2fa_backup_codes WHERE id = $1',
    [backupCodeId],
  );

  assert.equal(failed.statusCode, 503);
  assert.equal(afterRollback.rows[0].is_used, false);
  await assertPendingAndUnclaimed(challenge.token);

  assert.equal((await invoke(
    buildHandler(),
    withVerificationBody(req, { ...challenge, method: 'backup' }),
  )).statusCode, 200);
  const afterRetry = await databasePool.query(
    'SELECT is_used FROM user_2fa_backup_codes WHERE id = $1',
    [backupCodeId],
  );
  assert.equal(afterRetry.rows[0].is_used, true);
  assert.equal(await countLoginSessions(userId), 1);
});

test('rollback failure never releases the owned challenge', async (t) => {
  const req = createRequest();
  const { userId } = await createUser({ method: 'email' });
  const challenge = await createEmailChallenge(userId, req, '434343');
  t.after(() => cleanupChallenge(challenge.token));
  const rollbackFailingPool = {
    query: (...args) => databasePool.query(...args),
    async connect() {
      const client = await databasePool.connect();
      return {
        async query(sql, values) {
          if (String(sql).trim().toUpperCase() === 'ROLLBACK') {
            throw new Error('connection lost before rollback confirmation');
          }
          return client.query(sql, values);
        },
        release(destroy) {
          client.release(destroy);
        },
      };
    },
  };

  const response = await invoke(
    buildHandler({
      databasePool: rollbackFailingPool,
      async createSessionRecord() {
        throw new Error('force rollback');
      },
    }),
    withVerificationBody(req, { ...challenge, method: 'email' }),
  );

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'TWO_FA_ROLLBACK_OUTCOME_UNKNOWN');
  assert.equal((await getRawChallenge(challenge.token)).__voidTwoFactorState, 'claimed');
  assert.equal(await countLoginSessions(userId), 0);

  const replay = await invoke(
    buildHandler(),
    withVerificationBody(req, { ...challenge, method: 'email' }),
  );
  assert.equal(replay.statusCode, 409);
  assert.equal(await countLoginSessions(userId), 0);
});

test('an ambiguous COMMIT outcome never releases the claim or creates a second session', async (t) => {
  const req = createRequest();
  const { userId } = await createUser({ method: 'email' });
  const challenge = await createEmailChallenge(userId, req, '444444');
  t.after(() => cleanupChallenge(challenge.token));
  const ambiguousPool = {
    query: (...args) => databasePool.query(...args),
    async connect() {
      const client = await databasePool.connect();
      return {
        async query(sql, values) {
          if (String(sql).trim().toUpperCase() === 'COMMIT') {
            await client.query(sql, values);
            throw new Error('socket closed after COMMIT reached PostgreSQL');
          }
          return client.query(sql, values);
        },
        release(destroy) {
          client.release(destroy);
        },
      };
    },
  };

  const uncertain = await invoke(
    buildHandler({ databasePool: ambiguousPool }),
    withVerificationBody(req, { ...challenge, method: 'email' }),
  );

  assert.equal(uncertain.statusCode, 503);
  assert.equal(uncertain.body.code, 'TWO_FA_COMMIT_OUTCOME_UNKNOWN');
  assert.equal(await countLoginSessions(userId), 1);
  assert.equal((await getRawChallenge(challenge.token)).__voidTwoFactorState, 'claimed');

  const replay = await invoke(
    buildHandler(),
    withVerificationBody(req, { ...challenge, method: 'email' }),
  );
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.body.code, 'TWO_FA_SESSION_BUSY');
  assert.equal(await countLoginSessions(userId), 1);
});

test('finalization failure after COMMIT leaves the challenge fenced', async (t) => {
  const req = createRequest();
  const { userId } = await createUser({ method: 'email' });
  const challenge = await createEmailChallenge(userId, req, '555555');
  t.after(() => cleanupChallenge(challenge.token));

  const failedFinalization = await invoke(
    buildHandler({
      async finalizeChallenge() {
        throw new Error('Valkey finalization unavailable');
      },
    }),
    withVerificationBody(req, { ...challenge, method: 'email' }),
  );

  assert.equal(failedFinalization.statusCode, 503);
  assert.equal(failedFinalization.body.code, 'TWO_FA_POST_COMMIT_SECURITY_FAILURE');
  assert.equal(await countLoginSessions(userId), 1);
  assert.equal((await getRawChallenge(challenge.token)).__voidTwoFactorState, 'claimed');

  const replay = await invoke(
    buildHandler(),
    withVerificationBody(req, { ...challenge, method: 'email' }),
  );
  assert.equal(replay.statusCode, 409);
  assert.equal(await countLoginSessions(userId), 1);
});

test('an email snapshot changed before claim rejects the old code without a login', async (t) => {
  const req = createRequest();
  const { userId } = await createUser({ method: 'email' });
  const challenge = await createEmailChallenge(userId, req, '666666');
  t.after(() => cleanupChallenge(challenge.token));
  let changed = false;
  const changingPool = {
    query: (...args) => databasePool.query(...args),
    async connect() {
      if (!changed) {
        changed = true;
        const current = await getPendingTwoFactorSession(challenge.token);
        assert.equal(await updatePendingTwoFactorSession(challenge.token, current, {
          ...current,
          emailCodeHash: hashEmailCode(challenge.token, '777777'),
          emailCodeExpiresAt: Date.now() + 60_000,
        }), 'updated');
      }
      return databasePool.connect();
    },
  };

  const response = await invoke(
    buildHandler({ databasePool: changingPool }),
    withVerificationBody(req, { ...challenge, method: 'email' }),
  );

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'TWO_FA_SESSION_CHANGED');
  assert.equal(await countLoginSessions(userId), 0);
  await assertPendingAndUnclaimed(challenge.token);

  const oldCodeRetry = await invoke(
    buildHandler(),
    withVerificationBody(req, { ...challenge, method: 'email' }),
  );
  assert.equal(oldCodeRetry.statusCode, 400);
  assert.equal(await countLoginSessions(userId), 0);
});

test('a method disabled after prevalidation cannot complete and the released challenge can retry', async (t) => {
  const req = createRequest();
  const { userId } = await createUser({ method: 'email' });
  const challenge = await createEmailChallenge(userId, req, '888888');
  t.after(() => cleanupChallenge(challenge.token));
  let disabled = false;
  const disablingPool = {
    query: (...args) => databasePool.query(...args),
    async connect() {
      if (!disabled) {
        disabled = true;
        await databasePool.query(
          'UPDATE user_2fa SET is_enabled = false WHERE user_id = $1',
          [userId],
        );
      }
      return databasePool.connect();
    },
  };

  const response = await invoke(
    buildHandler({ databasePool: disablingPool }),
    withVerificationBody(req, { ...challenge, method: 'email' }),
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'TWO_FA_METHOD_UNAVAILABLE');
  assert.equal(await countLoginSessions(userId), 0);
  await assertPendingAndUnclaimed(challenge.token);

  await databasePool.query(
    'UPDATE user_2fa SET is_enabled = true WHERE user_id = $1',
    [userId],
  );
  assert.equal((await invoke(
    buildHandler(),
    withVerificationBody(req, { ...challenge, method: 'email' }),
  )).statusCode, 200);
  assert.equal(await countLoginSessions(userId), 1);
});

test('a wrong TOTP increments failures without claiming the challenge', async (t) => {
  const req = createRequest();
  const { userId, secret } = await createUser({ method: 'totp' });
  const challenge = await createTotpChallenge(userId, secret, req);
  t.after(() => cleanupChallenge(challenge.token));
  let wrongCode = '000000';
  while (totp.verifyToken(wrongCode, secret)) {
    wrongCode = String((Number(wrongCode) + 1) % 1_000_000).padStart(6, '0');
  }

  const response = await invoke(
    buildHandler(),
    withVerificationBody(req, {
      token: challenge.token,
      code: wrongCode,
      method: 'totp',
    }),
  );

  assert.equal(response.statusCode, 400);
  await assertPendingAndUnclaimed(challenge.token);
  assert.equal(await valkey.get(getChallengeKeys(challenge.token)[1]), '1');
  assert.equal(await countLoginSessions(userId), 0);
});
