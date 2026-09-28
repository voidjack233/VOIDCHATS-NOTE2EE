import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import cassandra from 'cassandra-driver';
import { Queue } from 'bullmq';
import sharp from 'sharp';
import { sanitizeChatAttachmentImageInWorker } from '../../../server/attachmentSanitizer/client.js';
import { root, services } from '../media/fixtures.js';
import { waitFor, parseTrace as cqlTrace } from './scyllaShutdownFixture.js';

export const workerProbePath = join(root, 'scripts/tests/health/workerLifecycleProbe.cjs');
export function workerTrace(output, pid) {
  return output.split('\n').filter((line) => line.startsWith('[WORKER_TRACE] '))
    .map((line) => JSON.parse(line.slice('[WORKER_TRACE] '.length)))
    .filter((event) => !pid || event.pid === pid);
}

export async function createWorkerShutdownFixture(t, { failPgEnd = false } = {}) {
  const cleanup = [];
  t.after(async () => {
    const failures = [];
    for (const task of cleanup.reverse()) {
      try { await task(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Worker fixture cleanup failed');
  });
  const storage = await services({ after: (task) => cleanup.push(task) }, { migrate: false });
  const appRoot = join(storage.directory, 'app');
  mkdirSync(appRoot);
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'void-app', type: 'module' }));
  writeFileSync(join(appRoot, '.env'), '', { mode: 0o600 });
  symlinkSync(join(root, 'db'), join(appRoot, 'db'));
  const keyspace = `void_worker_shutdown_${randomUUID().replaceAll('-', '')}`;
  const env = { ...storage.env, NODE_ENV: 'test', VOIDAPP_ROOT: appRoot,
    SCYLLA_HOST: '127.0.0.1:9042', SCYLLA_KEYSPACE: keyspace,
    SCYLLA_LOCAL_DATACENTER: 'datacenter1', SCYLLA_REPLICATION_FACTOR: '1',
    MINIO_BUCKET: 'avatars', MINIO_GROUP_AVATAR_BUCKET: 'group-avatars',
    CDN_URL: `http://127.0.0.1:${storage.env.MINIO_PORT}`,
    ATTACHMENT_SANITIZER_SOCKET_PATH: join(storage.directory, 'ipc', 'attachment.sock'),
    VMD_TRANSFORM_SOCKET_PATH: join(storage.directory, 'ipc', 'vmd.sock'),
    ...(failPgEnd ? { WORKER_SHUTDOWN_TEST_FAIL_PG_END: '1' } : {}),
  };
  for (const [key, production] of [['PGPORT', '5432'], ['VALKEY_PORT', '6379'], ['MINIO_PORT', '9000']]) {
    assert.notEqual(env[key], production);
  }
  const admin = new cassandra.Client({ contactPoints: ['127.0.0.1:9042'], localDataCenter: 'datacenter1' });
  cleanup.push(() => admin.shutdown());
  await admin.connect();
  assert.equal((await admin.execute('SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name=?',
    [keyspace], { prepare: true })).rows.length, 0);
  cleanup.push(() => {
    assert.match(keyspace, /^void_worker_shutdown_[a-f0-9]+$/);
    return admin.execute(`DROP KEYSPACE IF EXISTS ${keyspace}`, [], { readTimeout: 60_000 });
  });
  execFileSync('npm', ['run', 'migrate'], { cwd: root, env, stdio: 'pipe', timeout: 120_000 });
  const userId = randomUUID(), profileId = '970000000000000001';
  await storage.pool.query('INSERT INTO users(id,username,email,password_hash) VALUES($1,$2,$3,$4)',
    [userId, 'worker_shutdown', 'worker_shutdown@test.invalid', 'unused']);
  await storage.pool.query('INSERT INTO user_profiles(id,user_id,display_name) VALUES($1,$2,$3)',
    [profileId, userId, 'Worker Shutdown']);
  await storage.pool.query('UPDATE users SET profile_id=$1 WHERE id=$2', [profileId, userId]);
  const queue = new Queue('image-processing', { connection: {
    host: env.VALKEY_HOST, port: Number(env.VALKEY_PORT), db: Number(env.VALKEY_DB),
  } });
  cleanup.push(() => queue.close());
  const image = await sharp({ create: { width: 24, height: 18, channels: 3, background: '#246ace' } }).png().toBuffer();
  const nodeArgs = ['--require', workerProbePath];
  if (process.env.WORKER_SHUTDOWN_TEST_BUILT !== '1') nodeArgs.push('--import', join(root, 'node_modules/tsx/dist/loader.mjs'));
  const script = join(root, process.env.WORKER_SHUTDOWN_TEST_BUILT === '1'
    ? 'dist/server/entrypoints/worker-server.js' : 'server/entrypoints/worker-server.ts');

  function verifyTargets(pid) {
    const actual = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
      .map((item) => { const i = item.indexOf('='); return [item.slice(0, i), item.slice(i + 1)]; }));
    for (const key of ['VOIDAPP_ROOT', 'PGHOST', 'PGPORT', 'PGDATABASE', 'VALKEY_HOST', 'VALKEY_PORT',
      'SCYLLA_HOST', 'SCYLLA_KEYSPACE', 'MINIO_ENDPOINT', 'MINIO_PORT',
      'ATTACHMENT_SANITIZER_SOCKET_PATH', 'VMD_TRANSFORM_SOCKET_PATH']) assert.equal(actual[key], env[key], key);
  }
  async function ready(logs, pid) {
    await waitFor(() => logs().includes(`Worker service running (PID ${pid},`) && logs().includes('ScyllaDB connected'));
    verifyTargets(pid);
  }
  async function sanitize() {
    const result = await sanitizeChatAttachmentImageInWorker(image, 'image/png', {
      socketPath: env.ATTACHMENT_SANITIZER_SOCKET_PATH, timeoutMs: 5_000,
    });
    assert.equal(result.width, 24); assert.equal(result.height, 18);
    assert.equal(result.contentType, 'image/png');
    assert.equal((await sharp(result.buffer).metadata()).width, 24);
    return { width: result.width, height: result.height, bytes: result.buffer.length };
  }
  async function enqueue() {
    return queue.add('process-avatar', { userId, profileId, imageData: image.toString('base64'),
      oldFilename: null, queuedAt: Date.now() }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
  }
  async function verifyJob(job) {
    await waitFor(async () => (await job.getState()) === 'completed');
    const completed = await queue.getJob(job.id);
    assert.equal(completed.returnvalue.success, true);
    assert.equal(completed.attemptsMade, 1);
    const filename = completed.returnvalue.filename;
    const row = (await storage.pool.query('SELECT avatar_filename FROM user_profiles WHERE id=$1', [profileId])).rows[0];
    assert.equal(row.avatar_filename, filename);
    const stream = await storage.objects.getObject('avatars', filename);
    const parts = []; for await (const part of stream) parts.push(part);
    const metadata = await sharp(Buffer.concat(parts)).metadata();
    assert.equal(metadata.width, 256); assert.equal(metadata.height, 256); assert.equal(metadata.format, 'webp');
    const events = await storage.redis.xrange('bull:image-processing:events', '-', '+');
    const completions = events.map(([, fields]) => Object.fromEntries(Array.from({ length: fields.length / 2 },
      (_, i) => [fields[i * 2], fields[i * 2 + 1]]))).filter((event) => event.event === 'completed' && event.jobId === job.id);
    assert.equal(completions.length, 1);
    return { jobId: job.id, filename, attemptsMade: completed.attemptsMade, completedEvents: completions.length };
  }
  async function listAvatars() {
    const objects = []; for await (const object of storage.objects.listObjectsV2('avatars', '', true)) objects.push(object.name);
    return objects;
  }
  async function startDirect() {
    const child = spawn(process.execPath, [...nodeArgs, script], { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output += data; });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const closed = new Promise((resolve) => child.once('close', resolve));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } });
    await ready(() => output, child.pid);
    return { pid: child.pid, child, logs: () => output, exited, closed };
  }
  async function startPm2({ autorestart = true } = {}) {
    const pm2Home = join(storage.directory, 'pm2'); mkdirSync(pm2Home);
    const pm2Env = { ...env, PM2_HOME: pm2Home };
    const cli = async (args) => (await promisify(execFile)('pm2', args, { cwd: appRoot, env: pm2Env, timeout: 30_000 })).stdout;
    cleanup.push(() => cli(['kill']));
    const configPath = join(appRoot, 'worker-pm2.config.cjs');
    const out = join(pm2Home, 'worker.out'), err = join(pm2Home, 'worker.err');
    writeFileSync(configPath, `module.exports = ${JSON.stringify({ apps: [{ name: 'isolated-worker',
      script, cwd: appRoot, interpreter: process.execPath, node_args: nodeArgs, env, autorestart,
      kill_timeout: 10_000, out_file: out, error_file: err }] })};\n`);
    await cli(['start', configPath]);
    const logs = () => [out, err].map((path) => existsSync(path) ? readFileSync(path, 'utf8') : '').join('\n');
    const state = async () => JSON.parse(await cli(['jlist'])).find((process) => process.name === 'isolated-worker');
    const initial = await state();
    await ready(logs, initial.pid);
    return { pid: initial.pid, logs, state, ready, cli, pm2Home };
  }
  return { ...storage, env, appRoot, keyspace, queue, profileId, cleanup, ready, sanitize,
    enqueue, verifyJob, listAvatars, startDirect, startPm2 };
}

export function assertWorkerNaturalExit(output, pid) {
  const events = workerTrace(output, pid);
  assert.ok(!events.some((event) => event.event === 'explicit-exit'), output);
  assert.doesNotMatch(output, /Worker shutdown timed out|Worker shutdown failed|remained alive after shutdown cleanup/);
  const natural = events.findLast((event) => event.event === 'natural-before-exit');
  assert.ok(natural, output); assert.equal(natural.code, 0);
  const state = natural.state;
  assert.ok(state.redis.length >= 7, JSON.stringify(state));
  assert.ok(state.redis.every((client) => client.socket.destroyed && client.status === 'end'), JSON.stringify(state));
  assert.ok(state.queues.every((queue) => queue.closed), JSON.stringify(state));
  assert.ok(state.servers.length === 2 && state.servers.every((server) => !server.listening), JSON.stringify(state));
  assert.ok(state.postgres.length === 1 && state.postgres.every((pool) => pool.ended && pool.total === 0 && pool.queries === 0
    && pool.sockets.every((socket) => socket.destroyed)), JSON.stringify(state));
  assert.deepEqual(state.activeJobs, []); assert.equal(state.connectedToPm2, false);
  assert.equal(state.activeSharpPromises, 0);
  assert.ok(state.timers.every((timer) => !timer.referenced), JSON.stringify(state));
  assert.deepEqual(state.handles, []);
  const cql = cqlTrace(output).findLast((event) => event.event === 'natural-before-exit' && event.pid === pid);
  assert.equal(cql.code, 0);
  assert.equal(cql.state.clientCount, 1);
  assert.ok(cql.state.connections.every((connection) => connection.destroyed));
  assert.ok(cql.state.hosts.every((host) => host.connections.length === 0 && !host.reconnectScheduled));
  const signal = events.find((event) => event.event === 'signal');
  return { pid, durationMs: natural.time - signal.time, remainingValkeySockets: 0, remainingScyllaSockets: 0,
    remainingUnixListeners: 0, postgresEnded: true, fallbackFired: false };
}

export async function terminateWorker(service) {
  assert.equal(service.child.kill('SIGTERM'), true);
  const controller = new AbortController();
  let result;
  try { result = await Promise.race([service.exited, delay(8_000, null, { signal: controller.signal })]); }
  finally { controller.abort(); }
  assert.deepEqual(result, { code: 0, signal: null }, service.logs());
  await service.closed;
  return assertWorkerNaturalExit(service.logs(), service.pid);
}
