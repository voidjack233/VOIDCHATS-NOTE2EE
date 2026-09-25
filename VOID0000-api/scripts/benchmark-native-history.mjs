import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import cassandra from 'cassandra-driver';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { services, root, freePort, until } from './tests/media/fixtures.js';
import { createAttachmentBlobObjectKey } from '../server/attachments/lifecycleCore.js';

const baseline = 'fb8a4414281b8b3e12db9959427f22515f2ac30f';
if (!process.argv.includes('--local-scylla')) throw new Error('Require --local-scylla: temporary random keyspace on local Scylla; other stores isolated.');
const compare = process.argv.includes('--compare-working-tree');
const directory = mkdtempSync(join(tmpdir(), 'void-native-history-'));
const cleanups = [], t = { after: fn => cleanups.push(fn) };
const report = { baseline, started: new Date().toISOString(), node: process.version,
  harness: 'Real tsc-built message-server entrypoint in a separate Node process; benchmark-only preload; no VM handlers.',
  scope: 'Synthetic data, isolated PG/Valkey/MinIO, random local Scylla keyspace RF=1. Pool default 10 unchanged.',
  compare, rounds: [], counts: [], downloads: [], cleanupErrors: [] };
const output = join(root, 'benchmark-results', `native-history-${report.started.replaceAll(':', '-')}`);
mkdirSync(join(root, 'benchmark-results'), { recursive: true });
const summary = values => {
  const ordered = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / (values.length || 1),
    p50: ordered[Math.max(0, Math.ceil(values.length * .5) - 1)] || 0,
    p95: ordered[Math.max(0, Math.ceil(values.length * .95) - 1)] || 0, max: ordered.at(-1) || 0 };
};
const stageDelta = (before, after) => Object.fromEntries(Object.entries(after.stages).map(([key, value]) => {
  const count = value.count - before.stages[key].count, sumMs = value.sumMs - before.stages[key].sumMs;
  return [key, { count, sumMs, meanMs: sumMs / (count || 1), errors: value.errors - before.stages[key].errors }];
}));
const connection = { contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1' };
const keyspace = `void_native_bench_${randomUUID().replaceAll('-', '')}`;

function build(label) {
  const destination = join(directory, label); mkdirSync(destination);
  const archive = execFileSync('git', ['archive', baseline, 'VOID0000-api'], { cwd: join(root, '..'), maxBuffer: 100 * 1024 ** 2 });
  execFileSync('tar', ['-x', '-C', destination], { input: archive });
  const api = join(destination, 'VOID0000-api'); symlinkSync(join(root, 'node_modules'), join(api, 'node_modules'));
  if (label === 'candidate') copyFileSync(join(root, 'server/vmd/capability.ts'), join(api, 'server/vmd/capability.ts'));
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: api, stdio: 'pipe' });
  return api;
}

try {
  console.log('Compiling exact baseline into a private directory (no live build/deploy changes).');
  const builds = { baseline: build('baseline') };
  if (compare) builds.candidate = build('candidate');
  report.candidateSourceHash = compare ? createHash('sha256').update(readFileSync(join(root, 'server/vmd/capability.ts'))).digest('hex') : null;
  const storage = await services(t, { poolMax: 10 });
  // The fixture applies every SQL migration; also record that actual application
  // so the unmodified production startup compatibility check can run.
  await storage.pool.query('CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  for (const filename of readdirSync(join(root, 'db/migrations')).filter(name => name.endsWith('.sql'))) {
    const checksum = createHash('sha256').update(readFileSync(join(root, 'db/migrations', filename))).digest('hex');
    await storage.pool.query('INSERT INTO schema_migrations(filename,checksum) VALUES($1,$2)', [filename, checksum]);
  }
  const admin = new cassandra.Client(connection); await admin.connect(); t.after(() => admin.shutdown());
  const ddl = sql => admin.execute(sql, [], { readTimeout: 60_000 });
  t.after(() => ddl(`DROP KEYSPACE IF EXISTS ${keyspace}`));
  await ddl(`CREATE KEYSPACE ${keyspace} WITH replication = {'class':'NetworkTopologyStrategy','datacenter1':1} AND tablets = {'enabled':false}`);
  for (const sql of readFileSync(join(root, 'db/scylla-migrations/0000_message_storage.cql'), 'utf8').replaceAll('{{KEYSPACE}}', keyspace).split(';').map(s => s.trim()).filter(Boolean)) await ddl(sql);
  const scylla = new cassandra.Client({ ...connection, keyspace }); await scylla.connect(); t.after(() => scylla.shutdown());
  const secret = randomBytes(32).toString('hex'), fixtures = [];
  const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#526271' } }).jpeg().toBuffer();
  for (const [name, unique] of [['text', 0], ['image1', 1], ['image5', 5], ['image20', 20], ['duplicates20', 5]]) {
    const user = randomUUID(), conversation = randomUUID(), device = randomUUID(), sid = randomUUID(), descriptors = [];
    await storage.pool.query('INSERT INTO users(id,username,email,password_hash) VALUES($1,$2,$3,$4)', [user, user, `${user}@test.invalid`, 'unused']);
    await storage.pool.query("INSERT INTO conversations(id,type,owner_id) VALUES($1,'dm',$2)", [conversation, user]);
    await storage.pool.query("INSERT INTO conversation_members(conversation_id,user_id,role) VALUES($1,$2,'member')", [conversation, user]);
    for (let i = 0; i < unique; i++) {
      // Distinct valid files, canonical content-addressed keys and finalized metadata.
      const bytes = Buffer.concat([image, Buffer.from(`${conversation}:${i}`)]), hash = createHash('sha256').update(bytes).digest('hex');
      const key = createAttachmentBlobObjectKey(hash);
      await storage.objects.putObject('attachments', key, bytes, bytes.length, { 'Content-Type': 'image/jpeg', 'x-amz-meta-void-sanitized-image': '1' });
      const blob = await storage.pool.query(`INSERT INTO attachment_blobs(content_hash,bucket,object_key,size_bytes,content_type,inline,status)
        VALUES($1,'attachments',$2,$3,'image/jpeg',true,'ready') RETURNING id`, [hash, key, bytes.length]);
      const attachment = await storage.pool.query(`INSERT INTO attachment_objects(conversation_id,uploader_id,blob_id,filename,bucket,object_key)
        VALUES($1,$2,$3,'image.jpg','attachments',$4) RETURNING id`, [conversation, user, blob.rows[0].id, key]);
      descriptors.push(JSON.stringify({ url: `/api/conversations/${conversation}/attachments/${attachment.rows[0].id}`, mime: 'image/jpeg', width: 32, height: 24, name: 'image.jpg' }));
    }
    for (let i = 0; i < 20; i++) {
      const attachments = unique && (name === 'duplicates20' || i < unique) ? [descriptors[i % unique]] : [];
      await scylla.execute(`INSERT INTO messages(conversation_id,message_id,sender_id,content,message_type,attachments,created_at,is_deleted)
        VALUES(?,?,?,?,'text',?,?,false)`, [cassandra.types.Uuid.fromString(conversation), cassandra.types.TimeUuid.fromDate(new Date(Date.now() - (20 - i) * 1000)),
        cassandra.types.Uuid.fromString(user), `Native benchmark ${i}`, attachments, new Date(),], { prepare: true });
    }
    await storage.redis.set(`session:${user}:${device}`, JSON.stringify({ userId: user, deviceId: device, sessionId: sid,
      createdAt: Date.now(), lastSeenAt: Date.now(), ip: 'test', userAgent: 'test', deviceName: 'test', deviceType: 'test' }));
    const token = jwt.sign({ id: user, device_id: device, sid, type: 'access', jti: randomUUID() }, secret, { expiresIn: '1h' });
    fixtures.push({ name, unique, user, conversation, cookie: `accessToken=${token}` });
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...storage.env, NODE_ENV: 'production', HOST: '127.0.0.1', MESSAGE_SERVICE_PORT: String(port), FRONT_URL: 'http://localhost:5173',
    SCYLLA_HOST: '127.0.0.1', SCYLLA_KEYSPACE: keyspace, SCYLLA_LOCAL_DATACENTER: 'datacenter1', SCYLLA_REPLICATION_FACTOR: '1',
    ACCESS_SECRET: secret, REFRESH_SECRET: randomBytes(32).toString('hex'), CSRF_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    TOTP_ENCRYPTION_KEY: randomBytes(32).toString('hex'), TWO_FACTOR_CODE_SECRET: randomBytes(32).toString('hex'),
    CDN_URL: `http://127.0.0.1:${storage.env.MINIO_PORT}`, VMD_PUBLIC_URL: 'https://vmd.invalid', VMD_SIGNING_SECRET: secret };
  const wave = async (fixture, concurrency) => {
    await storage.redis.del(`rl:messages:fetch:user:${fixture.user}`);
    return Promise.all(Array.from({ length: concurrency }, async () => {
      const started = performance.now();
      const response = await fetch(`${base}/api/conversations/${fixture.conversation}/messages?limit=20`, { headers: { cookie: fixture.cookie }, signal: AbortSignal.timeout(10_000) });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.messages.length, 20);
      const attachments = body.messages.flatMap(m => m.attachments || []).map(s => JSON.parse(s));
      assert.equal(attachments.length, fixture.name === 'duplicates20' ? 20 : fixture.unique);
      for (const a of attachments) {
        assert.equal(a.inline, true); assert.match(a.url, /X-Amz-Signature=/);
        assert.deepEqual(Object.keys(a.display_variants), ['small', 'medium', 'large']);
        assert.equal(a.display_url, a.display_variants.medium.url);
      }
      return { duration: performance.now() - started, attachments };
    }));
  };
  // ABBA controls ordering/warm-host bias; fixtures, credentials and service settings are identical.
  for (const [round, label] of (compare ? ['baseline', 'candidate', 'candidate', 'baseline'] : ['baseline']).entries()) {
    const api = builds[label];
    const child = fork(join(api, 'dist/server/entrypoints/message-server.js'), [], {
      cwd: api, env: { ...env, VOIDAPP_ROOT: api, VOID_HISTORY_BENCH_ROOT: api },
      execArgv: ['--import', join(root, 'scripts/tests/messages/nativeHistoryProbe.mjs')], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let logs = '', stopped = false;
    child.stdout.on('data', bytes => { logs = (logs + bytes).slice(-32_000); }); child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-32_000); });
    const stop = async () => {
      if (stopped || child.exitCode !== null || child.signalCode) return;
      stopped = true; const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); const deadline = setTimeout(() => child.kill('SIGKILL'), 12_000);
      await exited; clearTimeout(deadline);
    }; t.after(stop);
    let sequence = 0;
    const control = (command, options = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, cleanup = () => { clearTimeout(timer); child.off('message', receive); };
      const receive = response => { if (response.id !== id) return; cleanup(); response.error ? reject(new Error(response.error)) : resolve(response.result); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Probe timeout: ${command}\n${logs}`)); }, 15_000);
      child.on('message', receive); child.send({ id, command, ...options });
    });
    try {
      await until(async () => {
        if (child.exitCode !== null) throw new Error(`Compiled server exited: ${logs}`);
        return fetch(`${base}/health`).then(r => r.ok).catch(() => false);
      });
      for (const fixture of fixtures) {
        for (let i = 0; i < 10; i++) await wave(fixture, 1);
        await control('start', { count: true }); const [sample] = await wave(fixture, 1);
        const counts = await control('stop');
        assert.equal(counts.originalCalls, fixture.unique); assert.equal(counts.capabilities, fixture.unique * 3);
        assert.equal(counts.derivations, fixture.unique * (label === 'baseline' ? 3 : 1));
        assert.equal(counts.statCalls, 0); assert.equal(counts.transportCalls, 0);
        report.counts.push({ round, label, name: fixture.name, original: counts.originalCalls, capabilities: counts.capabilities, derivations: counts.derivations, hmacsIncludingAuth: counts.hmacs, network: counts.transportCalls });
        if (sample.attachments.length) {
          const response = await fetch(sample.attachments[0].url); assert.equal(response.status, 200);
          assert.equal(response.headers.get('content-type'), 'image/jpeg'); assert.ok((await response.arrayBuffer()).byteLength > 0);
          report.downloads.push({ round, label, name: fixture.name, originalStatus: response.status });
        }
        for (const concurrency of fixture.name === 'image20' ? [1, 10, 50, 100] : [1]) {
          await control('start'); const durations = [];
          for (let i = 0; i < (concurrency === 1 ? 50 : 5); i++) {
            const results = await wave(fixture, concurrency); durations.push(...results.map(r => r.duration));
            if (Math.max(...results.map(r => r.duration)) > 2000) throw new Error('Safety stop: request >2s');
          }
          const measured = await control('stop'); assert.ok(measured.peakRss < 1024 ** 3, 'Server RSS must remain <1GiB');
          const stages = stageDelta(measured.before, measured.after); assert.equal(stages.total.count, durations.length); assert.equal(stages.total.errors, 0);
          assert.equal(measured.originalCalls, fixture.unique * durations.length);
          assert.equal(measured.statCalls, 0); assert.equal(measured.transportCalls, 0);
          const result = { round, label, name: fixture.name, concurrency, requests: durations.length, clientMs: summary(durations), stages,
            cpuMsPerRequest: measured.cpuMs / durations.length, loop: measured.loop, pgWaitMs: summary(measured.pgWaitMs), pgWaitingMax: measured.pgWaitingMax,
            statCalls: measured.statCalls, transportCalls: measured.transportCalls, originalCalls: measured.originalCalls,
            sentinel: Object.fromEntries(['started', 'joined', 'succeeded', 'failed', 'bypassed'].map(k => [k, measured.sentinelAfter[k] - measured.sentinelBefore[k]])) };
          report.rounds.push(result); console.log(JSON.stringify({ round, label, name: fixture.name, concurrency, totalMs: stages.total.meanMs,
            attachmentMs: stages.attachment_delivery.meanMs, vmdMsPerPage: stages.vmd_signing.sumMs / durations.length,
            cpuMs: result.cpuMsPerRequest, loop: result.loop, pgWait: result.pgWaitMs.mean }));
          await delay(100);
        }
      }
      await control('profileStart');
      for (let i = 0; i < 200; i++) await wave(fixtures.find(f => f.name === 'image20'), 1);
      const profile = await control('profileStop'); writeFileSync(`${output}-${round}-${label}.cpuprofile`, JSON.stringify(profile));
      await stop();
    } catch (error) { console.error(logs); throw error; }
  }
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
finally {
  for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (error) { report.cleanupErrors.push(error.message); process.exitCode = 1; }
  rmSync(directory, { recursive: true, force: true }); report.completed = new Date().toISOString();
  writeFileSync(`${output}.json`, JSON.stringify(report, null, 2)); console.log(`Report: ${output}.json`);
}
