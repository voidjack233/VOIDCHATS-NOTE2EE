import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Redis } from 'ioredis';
import { valkeyRetryDelay } from '../../../server/valkeyRetry.js';

async function waitFor(predicate, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('shared Valkey retry delay continues beyond the former limit and stays capped', () => {
  assert.equal(valkeyRetryDelay(1), 200);
  assert.equal(valkeyRetryDelay(10), 2000);
  assert.equal(valkeyRetryDelay(11), 2000);
  assert.equal(valkeyRetryDelay(1000), 2000);
});

test('bounded requests fail during a prolonged outage and reconnect after recovery', async (t) => {
  if (spawnSync('valkey-server', ['--version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('valkey-server is unavailable');
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'void-valkey-reconnect-'));
  const port = await unusedPort();
  let attempts = 0;
  const client = new Redis({
    host: '127.0.0.1', port, lazyConnect: false, maxRetriesPerRequest: 3,
    retryStrategy(times) {
      attempts = times;
      return Math.min(valkeyRetryDelay(times), 5);
    },
  });
  client.on('error', () => {});
  let server;
  t.after(async () => {
    client.disconnect();
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
    await rm(root, { recursive: true, force: true });
  });

  await waitFor(() => attempts > 10, 'more than ten connection retries');
  await assert.rejects(client.ping(), /Reached the max retries per request limit/);
  assert.notEqual(client.status, 'end');

  server = spawn('valkey-server', [
    '--bind', '127.0.0.1', '--port', String(port), '--save', '',
    '--appendonly', 'no', '--dir', root,
  ], { stdio: 'ignore' });
  await waitFor(() => client.status === 'ready', 'Valkey reconnection');
  assert.equal(await client.ping(), 'PONG');
  assert.ok(attempts > 10);
});
