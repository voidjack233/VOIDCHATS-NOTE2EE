import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import cassandra from 'cassandra-driver';
import { services, root } from './tests/media/fixtures.js';
import { sendAuditFixture } from './tests/messages/sendAuditFixture.js';
import { measurePush } from './tests/messages/pushAuditFixture.js';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

if (!process.argv.includes('--local-scylla')) throw new Error('Require --local-scylla for a disposable keyspace only');
const fixed = process.argv.includes('--fixed');
if (!fixed) throw new Error('The baseline race mode must only be run on the pre-fix revision; current source requires --fixed');
const cleanups = [], t = { after: fn => cleanups.push(fn) }, report = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), started: new Date().toISOString(), races: [], scenarios: [] };
report.mode = 'fixed-working-tree';
report.workingTree = execFileSync('git', ['status', '--short'], { encoding: 'utf8' });
try {
  const storage = await services(t, { poolMax: 10 });
  const keyspace = `void_send_audit_${randomUUID().replaceAll('-', '')}`;
  const admin = new cassandra.Client({ contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1' });
  await admin.connect(); t.after(() => admin.shutdown());
  const ddl = sql => admin.execute(sql, [], { readTimeout: 60_000 });
  t.after(() => ddl(`DROP KEYSPACE IF EXISTS ${keyspace}`));
  await ddl(`CREATE KEYSPACE ${keyspace} WITH replication = {'class':'NetworkTopologyStrategy','datacenter1':1} AND tablets = {'enabled':false}`);
  for (const sql of readFileSync(join(root, 'db/scylla-migrations/0000_message_storage.cql'), 'utf8').replaceAll('{{KEYSPACE}}', keyspace).split(';').map(s => s.trim()).filter(Boolean)) await ddl(sql);
  const scyllaClient = new cassandra.Client({ contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1', keyspace });
  await scyllaClient.connect(); t.after(() => scyllaClient.shutdown());
  for (const images of [0, 1]) for (const concurrency of [2, 10]) {
    const f = await sendAuditFixture(t, storage, { images, scyllaClient, missBarrier: fixed ? 0 : concurrency });
    const clientId = randomUUID(), body = { client_message_id: clientId, attachments: f.attachments };
    const responses = await Promise.all(Array.from({ length: concurrency }, () => f.request(body))); await f.drain();
    const stored = await scyllaClient.execute('SELECT message_id FROM messages WHERE conversation_id=?', [cassandra.types.Uuid.fromString(f.conversation)], { prepare: true });
    const result = { images, concurrency, statuses: responses.map(r => r.status), messageIds: responses.filter(r => r.status === 201).map(r => r.body.message.message_id),
      rows: stored.rows.length, unread: await f.unread(), publishes: f.counts.publishes.length, pushDispatches: f.counts.push,
      cache: await storage.redis.get(`message:idempotency:${f.user}:${f.conversation}:${clientId}`) };
    report.races.push(result); console.log(JSON.stringify(result));
    assert.equal(result.rows, fixed || images ? 1 : concurrency);
    if (fixed) {
      await f.resetLimits();
      const retry = await f.request(body);
      assert.equal(retry.status, 201, JSON.stringify(retry));
      assert.equal(retry.body.message.message_id, result.messageIds[0]);
      assert.equal(await f.unread(), 1);
    }
  }
  const f = await sendAuditFixture(t, storage, { scyllaClient }); f.faults.commit = 'applied';
  const unknown = await f.request({ client_message_id: randomUUID() });
  report.unknownCommit = { status: unknown.status, unread: await f.unread(), rows: (await scyllaClient.execute('SELECT message_id FROM messages WHERE conversation_id=?', [cassandra.types.Uuid.fromString(f.conversation)], { prepare: true })).rows.length };
  console.log(JSON.stringify({ unknownCommit: report.unknownCommit }));
  for (const options of [{ type: 'dm' }, { type: 'group', members: 10 }, { type: 'channel', members: 10 }, { type: 'group', members: 10, mention: true }, { type: 'dm', images: 1 }, { type: 'dm', images: 5 }, { type: 'group', members: 100 }, { type: 'group', members: 1000 }]) {
    const f = await sendAuditFixture(t, storage, { ...options, scyllaClient });
    const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
    const started = performance.now();
    const result = await f.request({ client_message_id: randomUUID(), attachments: f.attachments, ...(options.mention ? { mentions: [{ user_id: f.peer }] } : {}) });
    assert.equal(result.status, 201, JSON.stringify(result)); await f.drain();
    loop.disable();
    const scenario = { ...options, ms: result.ms, throughPublishDrainMs: performance.now() - started,
      eventLoopMaxDelayMs: loop.max / 1e6, counts: structuredClone(f.counts) };
    scenario.warmMs = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      await f.resetLimits();
      const attachments = [];
      for (const descriptor of f.attachments) {
        const parsed = JSON.parse(descriptor), oldId = parsed.url.split('/').at(-1);
        const inserted = await storage.pool.query(`INSERT INTO attachment_objects(conversation_id,uploader_id,blob_id,filename,bucket,object_key,size_bytes,status,staged_at,expires_at)
          SELECT conversation_id,uploader_id,blob_id,filename,bucket,object_key,size_bytes,'staged',NOW(),NOW()+INTERVAL '1 hour'
          FROM attachment_objects WHERE id=$1 RETURNING id`, [oldId]);
        attachments.push(JSON.stringify({ ...parsed, url: parsed.url.replace(oldId, inserted.rows[0].id) }));
      }
      const warm = await f.request({ client_message_id: randomUUID(), attachments,
        ...(options.mention ? { mentions: [{ user_id: f.peer }] } : {}) });
      assert.equal(warm.status, 201, JSON.stringify(warm)); await f.drain();
      scenario.warmMs.push(warm.ms);
    }
    if (!options.images && !options.mention && options.type !== 'channel') scenario.push = await measurePush(storage, f);
    report.scenarios.push(scenario); console.log(JSON.stringify({ ...options, ms: result.ms, warmMs: scenario.warmMs,
      pg: scenario.counts.pg.length, valkey: scenario.counts.valkey.length, batches: scenario.counts.batches,
      publishes: scenario.counts.publishes.length, push: scenario.push }));
  }
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
finally {
  report.cleanupErrors = [];
  for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (error) { report.cleanupErrors.push(error.message); process.exitCode = 1; }
  mkdirSync(join(root, 'benchmark-results'), { recursive: true }); const file = join(root, 'benchmark-results', `send-audit-${report.started.replaceAll(':', '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2)); console.log(file);
}
