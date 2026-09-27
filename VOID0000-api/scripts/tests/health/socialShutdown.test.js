import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { freePort, root, services } from '../media/fixtures.js';

const EXIT_DEADLINE_MS = 1_250;

async function waitForReady(child, port, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `service exited before READY: ${logs()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) return;
    } catch { /* startup has not bound the listener yet */ }
    await delay(50);
  }
  assert.fail(`service did not become READY: ${logs()}`);
}

async function startAndStop(entrypoint, port, env, checkRequest) {
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => { output = (output + data).slice(-8_000); });
  }
  const logs = () => output;
  try {
    await waitForReady(child, port, logs);
    await checkRequest(port);

    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const closed = new Promise((resolve) => child.once('close', resolve));
    const started = performance.now();
    assert.equal(child.kill('SIGTERM'), true);
    const result = await Promise.race([exited, delay(EXIT_DEADLINE_MS).then(() => null)]);
    const elapsedMs = performance.now() - started;
    assert.ok(result, `${entrypoint} remained alive after SIGTERM: ${logs()}`);
    assert.deepEqual(result, { code: 0, signal: null }, logs());
    assert.ok(elapsedMs < EXIT_DEADLINE_MS, `shutdown took ${elapsedMs}ms`);
    await closed;
    assert.doesNotMatch(logs(), /remained alive after shutdown cleanup|graceful shutdown timed out/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/ready`, {
      signal: AbortSignal.timeout(500),
    }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
}

test('real social process releases queue sockets and exits after SIGTERM', async (t) => {
  const fixture = await services(t);
  const socialPort = await freePort();
  const accountPort = await freePort();
  const userId = randomUUID();
  const profileId = '900001';
  const deviceId = 'shutdown-test-device';
  const sessionId = randomUUID();
  const accessSecret = `isolated-access-${randomBytes(32).toString('hex')}`;
  const env = {
    ...fixture.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    SOCIAL_SERVICE_PORT: String(socialPort),
    PORT: String(accountPort),
    CDN_URL: `http://127.0.0.1:${fixture.env.MINIO_PORT}`,
    ACCESS_SECRET: accessSecret,
    REFRESH_SECRET: `isolated-refresh-${randomBytes(32).toString('hex')}`,
    CSRF_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    TOTP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    TWO_FACTOR_CODE_SECRET: `isolated-two-factor-${randomBytes(32).toString('hex')}`,
  };

  await fixture.pool.query(
    'INSERT INTO users(id,username,email,password_hash) VALUES($1,$2,$3,$4)',
    [userId, 'shutdown-test', 'shutdown@test.invalid', 'unused'],
  );
  await fixture.pool.query(
    'INSERT INTO user_profiles(id,user_id,display_name) VALUES($1,$2,$3)',
    [profileId, userId, 'Shutdown Test'],
  );
  await fixture.pool.query('UPDATE users SET profile_id=$1 WHERE id=$2', [profileId, userId]);
  const now = Date.now();
  await fixture.redis.set(`session:${userId}:${deviceId}`, JSON.stringify({
    userId, deviceId, sessionId, createdAt: now, lastSeenAt: now,
    ip: '127.0.0.1', userAgent: 'isolated-test', deviceName: 'test', deviceType: 'desktop',
  }), 'EX', 600);
  const token = jwt.sign({
    id: userId, profile_id: profileId, device_id: deviceId, sid: sessionId,
    jti: randomUUID(), type: 'access',
  }, accessSecret, { expiresIn: '10m' });
  const headers = { Cookie: `accessToken=${token}` };

  await startAndStop('server/entrypoints/social-server.ts', socialPort, env, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/users/${profileId}`, { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).username, 'shutdown-test');
  });

  await startAndStop('server/entrypoints/account-server.ts', accountPort, env, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/users/account`, { headers });
    assert.equal(response.status, 200);
    assert.match(JSON.stringify(await response.json()), new RegExp(userId));
  });
});
