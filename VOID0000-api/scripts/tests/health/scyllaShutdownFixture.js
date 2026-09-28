import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID, createCipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import cassandra from 'cassandra-driver';
import jwt from 'jsonwebtoken';
import { startAttachmentSanitizerServer } from '../../../server/attachmentSanitizer/server.js';
import { freePort, root, services } from '../media/fixtures.js';

const TRACE_PREFIX = '[CQL_TRACE] ';
export const probePath = join(root, 'scripts/tests/health/scyllaLifecycleProbe.cjs');

export async function waitFor(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  assert.fail(`Isolated Scylla shutdown fixture timed out after ${timeoutMs}ms`);
}

export function parseTrace(output) {
  return output.split('\n').filter((line) => line.startsWith(TRACE_PREFIX))
    .map((line) => JSON.parse(line.slice(TRACE_PREFIX.length)));
}

export async function createScyllaShutdownFixture(t) {
  const cleanup = [];
  t.after(async () => {
    const failures = [];
    for (const task of cleanup.reverse()) {
      try { await task(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Isolated fixture cleanup failed');
  });
  const storage = await services({ after: (task) => cleanup.push(task) }, { migrate: false });
  const appRoot = join(storage.directory, 'app');
  mkdirSync(appRoot);
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'void-app', type: 'module' }));
  writeFileSync(join(appRoot, '.env'), '', { mode: 0o600 });
  symlinkSync(join(root, 'db'), join(appRoot, 'db'));
  const keyspace = `void_scylla_shutdown_${randomUUID().replaceAll('-', '')}`;
  const ports = { message: await freePort(), conversation: await freePort(), proxy: await freePort() };
  const socketPath = join(storage.directory, 'ipc', 'attachment.sock');
  const env = {
    ...storage.env, VOIDAPP_ROOT: appRoot, NODE_ENV: 'test', HOST: '127.0.0.1',
    SCYLLA_HOST: '127.0.0.1:9042', SCYLLA_KEYSPACE: keyspace,
    SCYLLA_LOCAL_DATACENTER: 'datacenter1', SCYLLA_REPLICATION_FACTOR: '1',
    MESSAGE_SERVICE_PORT: String(ports.message), CONVERSATION_SERVICE_PORT: String(ports.conversation),
    CDN_URL: `http://127.0.0.1:${storage.env.MINIO_PORT}`,
    MINIO_BUCKET: 'avatars', MINIO_GROUP_AVATAR_BUCKET: 'group-avatars',
    ATTACHMENT_SANITIZER_SOCKET_PATH: socketPath,
    ACCESS_SECRET: randomBytes(40).toString('hex'), REFRESH_SECRET: randomBytes(40).toString('hex'),
    CSRF_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    TOTP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    TWO_FACTOR_CODE_SECRET: randomBytes(40).toString('hex'),
    VMD_SIGNING_SECRET: randomBytes(40).toString('hex'), VMD_PUBLIC_URL: 'http://isolated.invalid',
    VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '',
  };
  assert.notEqual(env.PGPORT, '5432');
  assert.notEqual(env.VALKEY_PORT, '6379');
  assert.notEqual(env.MINIO_PORT, '9000');
  const admin = new cassandra.Client({ contactPoints: ['127.0.0.1:9042'], localDataCenter: 'datacenter1' });
  cleanup.push(() => admin.shutdown());
  await admin.connect();
  assert.equal((await admin.execute('SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name=?',
    [keyspace], { prepare: true })).rows.length, 0);
  cleanup.push(() => {
    assert.match(keyspace, /^void_scylla_shutdown_[a-f0-9]+$/);
    return admin.execute(`DROP KEYSPACE IF EXISTS ${keyspace}`, [], { readTimeout: 60_000 });
  });
  execFileSync('npm', ['run', 'migrate'], { cwd: root, env, stdio: 'pipe', timeout: 120_000 });
  const tables = (await admin.execute('SELECT table_name FROM system_schema.tables WHERE keyspace_name=?',
    [keyspace], { prepare: true })).rows.map((row) => row.table_name);
  for (const table of ['messages', 'reaction_state', 'reaction_schema', 'schema_migrations']) assert.ok(tables.includes(table));
  const sanitizer = await startAttachmentSanitizerServer({ socketPath });
  cleanup.push(() => sanitizer.close());

  const users = [randomUUID(), randomUUID()], conversation = randomUUID(), group = randomUUID(), headers = {};
  for (let i = 0; i < users.length; i++) {
    const user = users[i], profile = String(960000000000000000n + BigInt(i));
    await storage.pool.query('INSERT INTO users(id,username,email,password_hash) VALUES($1,$2,$3,$4)',
      [user, `shutdown_${i}`, `shutdown_${i}@test.invalid`, 'unused']);
    await storage.pool.query('INSERT INTO user_profiles(id,user_id,display_name) VALUES($1,$2,$3)', [profile, user, 'Shutdown Test']);
    await storage.pool.query('UPDATE users SET profile_id=$1 WHERE id=$2', [profile, user]);
    const device = randomUUID(), sid = randomUUID();
    await storage.redis.set(`session:${user}:${device}`, JSON.stringify({
      userId: user, deviceId: device, sessionId: sid, createdAt: Date.now(), lastSeenAt: Date.now(),
      ip: '127.0.0.1', userAgent: 'test', deviceName: 'test', deviceType: 'test',
    }), 'EX', 600);
    const token = jwt.sign({ id: user, profile_id: profile, device_id: device, sid, jti: randomUUID(), type: 'access' },
      env.ACCESS_SECRET, { expiresIn: '10m' });
    const iv = randomBytes(16), plain = randomBytes(32).toString('base64url');
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(env.CSRF_ENCRYPTION_KEY, 'base64'), iv);
    let encrypted = cipher.update(JSON.stringify({ token: plain, timestamp: Date.now(), expires: Date.now() + 600_000 }), 'utf8', 'base64url');
    encrypted += cipher.final('base64url');
    headers[user] = {
      'content-type': 'application/json',
      cookie: `accessToken=${token}; _csrf=${iv.toString('base64url')}:${encrypted}:${cipher.getAuthTag().toString('base64url')}`,
      'x-csrf-token': plain,
    };
  }
  await storage.pool.query("INSERT INTO conversations(id,type,owner_id) VALUES($1,'dm',$2),($3,'group',$2)",
    [conversation, users[0], group]);
  for (const id of [conversation, group]) for (let i = 0; i < users.length; i++) {
    await storage.pool.query('INSERT INTO conversation_members(conversation_id,user_id,role) VALUES($1,$2,$3)',
      [id, users[i], id === group && i === 0 ? 'owner' : 'member']);
  }
  await storage.pool.query('INSERT INTO dm_pairs(conversation_id,user_a,user_b) VALUES($1,$2,$3)',
    [conversation, ...users.toSorted()]);
  await storage.pool.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES($1,$2,'accepted')", users);

  let proxy;
  const sockets = new Set();
  async function stopProxy() {
    if (!proxy?.listening) return;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  }
  cleanup.push(stopProxy);
  async function startProxy() {
    proxy = net.createServer((client) => {
      const upstream = net.connect({ host: '127.0.0.1', port: 9042 });
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on('error', () => { client.destroy(); upstream.destroy(); });
        socket.on('close', () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
      }
      client.pipe(upstream); upstream.pipe(client);
    });
    await new Promise((resolve) => proxy.listen(ports.proxy, '127.0.0.1', resolve));
  }
  async function ready(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(3_000) });
      return { status: response.status, body: await response.json() };
    } catch { return { status: 0 }; }
  }
  async function request(port, path, { method = 'GET', body, user = users[0] } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: headers[user], ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function exerciseMessages(port) {
    const path = `/api/conversations/${conversation}/messages`;
    assert.equal((await request(port, path)).status, 200);
    const sent = await request(port, path, { method: 'POST', body: { content: 'Scylla shutdown fixture', client_message_id: randomUUID() } });
    assert.equal(sent.status, 201, JSON.stringify(sent));
    const history = await request(port, path);
    assert.equal(history.status, 200);
    assert.ok(history.body.messages.some((message) => message.message_id === sent.body.message.message_id));
  }
  async function exerciseConversation(port) {
    const detail = await request(port, `/api/conversations/${group}`);
    assert.equal(detail.status, 200, JSON.stringify(detail));
    assert.equal(detail.body.conversation.members.length, 2);
    assert.equal((await request(port, `/api/conversations/${group}/permissions`)).status, 200);
  }
  function serviceEnv(entrypoint, viaProxy = false) {
    return { ...env, ...(viaProxy ? {
      SCYLLA_HOST: `127.0.0.1:${ports.proxy}`, SCYLLA_SHUTDOWN_TEST_HOST_REPLACEMENT: '1',
    } : {}) };
  }
  function verifyTargets(pid, expected) {
    const actual = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
      .map((item) => { const i = item.indexOf('='); return [item.slice(0, i), item.slice(i + 1)]; }));
    for (const key of ['VOIDAPP_ROOT', 'SCYLLA_HOST', 'SCYLLA_KEYSPACE', 'PGHOST', 'PGPORT', 'PGDATABASE',
      'VALKEY_HOST', 'VALKEY_PORT', 'MINIO_ENDPOINT', 'MINIO_PORT', 'ATTACHMENT_SANITIZER_SOCKET_PATH']) {
      assert.equal(actual[key], expected[key], `Unexpected isolated target ${key}`);
    }
  }
  async function startService(entrypoint, { viaProxy = false } = {}) {
    const childEnv = serviceEnv(entrypoint, viaProxy);
    const child = spawn(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'),
      '--require', probePath, join(root, `server/entrypoints/${entrypoint}-server.ts`)], {
      cwd: appRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output += data; });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const closed = new Promise((resolve) => child.once('close', resolve));
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
    });
    const port = ports[entrypoint];
    await waitFor(async () => {
      assert.equal(child.exitCode, null, output);
      return (await ready(port)).status === 200;
    });
    verifyTargets(child.pid, childEnv);
    return { child, port, pid: child.pid, logs: () => output, events: () => parseTrace(output), exited, closed };
  }
  return { ...storage, env, ports, keyspace, appRoot, users, conversation, group, startProxy, stopProxy,
    ready, request, exerciseMessages, exerciseConversation, serviceEnv, verifyTargets, startService };
}

export async function reconnectMessage(fixture, service) {
  await fixture.exerciseMessages(service.port);
  const outageStarted = Date.now();
  await fixture.stopProxy();
  await delay(1_000);
  assert.equal((await fixture.ready(service.port)).status, 503, service.logs());
  await delay(Math.max(0, 8_350 - (Date.now() - outageStarted)));
  await fixture.startProxy();
  const restored = Date.now();
  await waitFor(async () => (await fixture.ready(service.port)).status === 200, 30_000);
  const recoveryMs = Date.now() - restored;
  assert.equal((await fixture.ready(service.port)).body.pid, service.pid);
  await fixture.exerciseMessages(service.port);
  // Exercise the replaced Host path, not just a transient socket reconnect.
  assert.ok(service.events().some((event) => event.event === 'host-map-set' && event.previous !== null), service.logs());
  // Let the retired pool's real reconnect timer open its two core sockets.
  // Shutdown must close both stale sockets as well as the current pool.
  const snapshot = await waitFor(async () => {
    service.child.kill('SIGUSR2');
    await delay(50);
    const state = service.events().filter((event) => event.event === 'snapshot').at(-1);
    return state?.state.hosts.some((host) => !host.current && host.connections.length === 2) ? state : false;
  }, 10_000);
  assert.equal(snapshot.state.clientCount, 1);
  assert.ok(snapshot.state.hosts.some((host) => !host.current && host.core === 2 && host.connections.length === 2));
  return { outageMs: restored - outageStarted, recoveryMs,
    samePid: service.pid, retiredPoolSocketsBeforeShutdown: 2 };
}

export function assertNaturalScyllaExit(events, output) {
  assert.doesNotMatch(output, /remained alive after shutdown cleanup|graceful shutdown timed out|shutdown hook failed/);
  const natural = events.findLast((event) => event.event === 'natural-before-exit');
  assert.ok(natural, output);
  assert.equal(natural.code, 0);
  assert.equal(natural.state.clientCount, 1);
  assert.equal(natural.state.handles.filter((handle) => handle.remotePort).length, 0);
  assert.ok(natural.state.connections.every((connection) => connection.destroyed), JSON.stringify(natural));
  assert.ok(natural.state.hosts.every((host) => !host.reconnectScheduled && host.connections.length === 0), JSON.stringify(natural));
  return natural;
}

export async function terminateNaturally(service) {
  const started = Date.now();
  assert.equal(service.child.kill('SIGTERM'), true);
  const timer = new AbortController();
  let result;
  try { result = await Promise.race([service.exited, delay(1_500, null, { signal: timer.signal })]); }
  finally { timer.abort(); }
  assert.deepEqual(result, { code: 0, signal: null }, service.logs());
  await service.closed;
  const natural = assertNaturalScyllaExit(service.events(), service.logs());
  return { pid: service.pid, durationMs: Date.now() - started, remainingCqlSockets: 0, fallbackFired: false,
    naturalExitAt: natural.time };
}
