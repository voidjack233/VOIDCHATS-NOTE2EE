import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Session } from 'node:inspector/promises';
import cassandra from 'cassandra-driver';
import { services, root } from './tests/media/fixtures.js';
import { historyLatencyFixture } from './tests/messages/historyLatencyFixture.js';
import { Sentinel } from '../server/sentinel/index.js';
import { historyMetrics } from '../server/health/historyMetrics.js';

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
    p50: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] || 0,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] || 0, max: sorted.at(-1) || 0 };
}
function metricDelta(before, after) {
  return Object.fromEntries(Object.entries(after.stages).map(([stage, current]) => {
    const previous = before.stages[stage], count = current.count - previous.count;
    const buckets = current.buckets.map((n, i) => n - previous.buckets[i]);
    let seen = 0;
    const percentile = p => {
      seen = 0;
      const index = buckets.findIndex(n => { seen += n; return seen >= Math.ceil(count * p); });
      return count ? after.boundsMs[index] : 0;
    };
    return [stage, { count, errors: current.errors - previous.errors, sumMs: current.sumMs - previous.sumMs,
      meanMs: count ? (current.sumMs - previous.sumMs) / count : 0,
      p50UpperMs: percentile(.5), p95UpperMs: percentile(.95), buckets }];
  }));
}

// A separate HTTP client process keeps response parsing/client work off the server event loop.
if (process.argv.includes('--client')) {
  process.on('message', async ({ base, cookie, concurrency, limit, images, reactions, size }) => {
    try {
      const results = await Promise.all(Array.from({ length: concurrency }, async () => {
        const start = performance.now();
        const response = await fetch(`${base}?limit=${limit}`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
        const text = await response.text();
        assert.equal(response.status, 200);
        const body = JSON.parse(text);
        assert.equal(body.messages.length, Math.min(size, limit));
        assert.equal(new Set(body.messages.map(m => m.message_id)).size, body.messages.length);
        if (images) for (const message of body.messages) {
          const attachment = JSON.parse(message.attachments[0]);
          assert.equal(attachment.inline, true);
          assert.match(attachment.url, /X-Amz-Signature=/);
          assert.match(attachment.display_url, /^https:\/\/vmd.invalid\//);
        }
        if (reactions) for (const message of body.messages) {
          assert.equal(Object.keys(message.reactions).length, 6);
          assert.equal(message.reactions.like.me, true);
          assert.equal(message.reactions.heart.me, false);
        }
        return { durationMs: performance.now() - start, bytes: Buffer.byteLength(text) };
      }));
      process.send({ results });
    } catch (error) { process.send({ error: error.message }); }
  });
  process.on('disconnect', () => process.exit(0));
} else {
  if (!process.argv.includes('--local-scylla')) throw new Error('Pass --local-scylla to authorize temporary benchmark-keyspace creation on 127.0.0.1:9042. Production tables are never accessed.');
  const cleanups = [], t = { after: fn => cleanups.push(fn) };
  const keyspace = `void_history_bench_${randomUUID().replaceAll('-', '')}`;
  const connection = { contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1', pooling: {
    coreConnectionsPerHost: { [cassandra.types.distance.local]: 2, [cassandra.types.distance.remote]: 1 },
  } };
  const admin = new cassandra.Client(connection);
  let histogram, profiler;
  const report = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    instrumentedWorkingTree: true,
    workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    started: new Date().toISOString(), setup: {
      node: process.version, scope: 'local synthetic fixtures, shared local Scylla server, RF=1 temporary keyspace',
      postgres: 'isolated PostgreSQL 16, pool max=10 (application default)', valkey: 'isolated single ioredis connection',
      minio: 'isolated real SDK signing, static credentials and explicit region; image bytes not fetched',
      timing: 'server aggregate non-cumulative histograms; stages are inclusive wall time, not additive; client in separate process',
      harness: 'existing isolated VM loader executes current TypeScript handlers; no injected datastore latency; not a production process',
      repetitions: '20 waves at concurrency 1; 3 waves at 10/50/100; five warmup requests excluded',
    }, scenarios: [] };
  try {
    await admin.connect();
    t.after(() => admin.shutdown());
    const info = (await admin.execute('SELECT data_center,release_version FROM system.local')).rows[0];
    report.setup.scyllaProtocolRelease = info.release_version;
    // DDL may wait for schema/compaction work on a shared host. This setup-only
    // deadline does not change the application's measured query timeout or pools.
    const ddl = sql => admin.execute(sql, [], { readTimeout: 60_000 });
    t.after(() => ddl(`DROP KEYSPACE IF EXISTS ${keyspace}`));
    // Match migrationRunner: reaction counters require the existing non-tablet layout.
    await ddl(`CREATE KEYSPACE ${keyspace} WITH replication = {'class':'NetworkTopologyStrategy','datacenter1':1} AND tablets = {'enabled':false}`);
    const schema = readFileSync(join(root, 'db/scylla-migrations/0000_message_storage.cql'), 'utf8').replaceAll('{{KEYSPACE}}', keyspace);
    for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await ddl(statement);
    const scylla = new cassandra.Client({ ...connection, keyspace });
    await scylla.connect(); t.after(() => scylla.shutdown());
    const storage = await services(t, { poolMax: 10 });
    const client = fork(fileURLToPath(import.meta.url), ['--client'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    t.after(() => { client.disconnect(); client.kill(); });
    const wave = (fixture, options, concurrency, limit) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Benchmark client timeout')); }, 15_000);
      const cleanup = () => { clearTimeout(timer); client.off('message', message); client.off('exit', exit); };
      const exit = () => { cleanup(); reject(new Error('Benchmark client exited')); };
      const message = result => { cleanup(); result.error ? reject(new Error(result.error)) : resolve(result.results); };
      client.once('message', message); client.once('exit', exit);
      client.send({ ...fixture.client, ...options, concurrency, limit });
    });
    for (const options of [
      { name: 'text', size: 20 }, { name: 'images', size: 20, images: 20 },
      { name: 'reactions', size: 20, reactions: true }, { name: 'group', size: 20, group: true },
      { name: 'empty', size: 0 }, { name: 'reactions50', size: 50, reactions: true },
      { name: 'reactions100', size: 100, reactions: true },
    ]) {
      const sentinel = new Sentinel();
      const fixture = await historyLatencyFixture(t, storage, scylla, sentinel, options);
      const limit = Math.max(20, options.size);
      for (let i = 0; i < 5; i++) await wave(fixture, options, 1, limit);
      if (options.name === 'images' && process.argv.includes('--cpu-profile')) {
        profiler = new Session(); profiler.connect();
        await profiler.post('Profiler.enable');
        await profiler.post('Profiler.start');
      }
      for (const concurrency of options.size > 20 ? [1] : [1, 10, 50, 100]) {
        const before = historyMetrics.getSnapshot(), beforeSentinel = sentinel.getSnapshot();
        const values = { pgWaitMs: [], pgQueryMs: [], scyllaMs: [], valkeyMs: [] }, durations = [], responseBytes = [];
        let pgWaitingMax = 0, scyllaInFlightMax = 0, peakDriverInFlight = 0, minioStats = 0, cpuMicros = 0, activeMs = 0, idleMs = 0;
        histogram = monitorEventLoopDelay({ resolution: 2 }); histogram.enable();
        const driverSampler = setInterval(() => {
          const state = scylla.getState();
          peakDriverInFlight = Math.max(peakDriverInFlight, ...state.getConnectedHosts().map(host => state.getInFlightQueries(host)));
        }, 2);
        try {
          for (let repetition = 0; repetition < (concurrency === 1 ? 20 : 3); repetition++) {
            await fixture.reset();
            const cpu = process.cpuUsage(), loop = performance.eventLoopUtilization();
            const results = await wave(fixture, options, concurrency, limit);
            const used = process.cpuUsage(cpu), elu = performance.eventLoopUtilization(loop);
            cpuMicros += used.user + used.system; activeMs += elu.active; idleMs += elu.idle;
            durations.push(...results.map(r => r.durationMs)); responseBytes.push(...results.map(r => r.bytes));
            for (const key of Object.keys(values)) values[key].push(...fixture.counters[key]);
            pgWaitingMax = Math.max(pgWaitingMax, fixture.counters.pgWaitingMax);
            scyllaInFlightMax = Math.max(scyllaInFlightMax, fixture.counters.scyllaInFlightMax);
            minioStats += fixture.counters.minioStats;
            if (Math.max(...results.map(r => r.durationMs)) > 2000 || process.memoryUsage().rss > 1024 ** 3) throw new Error('Safety stop: request >2s or benchmark server RSS >1GiB');
            await delay(100);
          }
        } finally { clearInterval(driverSampler); histogram.disable(); }
        const afterSentinel = sentinel.getSnapshot();
        const result = { name: options.name, concurrency, requests: durations.length, clientMs: summary(durations), responseBytes: summary(responseBytes),
          stages: metricDelta(before, historyMetrics.getSnapshot()),
          operations: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, summary(v)])),
          pgWaitingMax, scyllaInFlightMax, peakDriverInFlight, minioStats,
          sentinel: { ...afterSentinel, ...Object.fromEntries(['started', 'joined', 'succeeded', 'failed', 'bypassed'].map(k => [k, afterSentinel[k] - beforeSentinel[k]])) },
          loop: { utilization: activeMs / (activeMs + idleMs), p95Ms: histogram.percentile(95) / 1e6, maxMs: histogram.max / 1e6 },
          cpuMsPerRequest: cpuMicros / 1000 / durations.length };
        assert.equal(result.stages.total.count, durations.length);
        assert.equal(result.stages.total.errors, 0);
        assert.equal(minioStats, 0);
        assert.equal(result.operations.valkeyMs.count, durations.length * 2);
        report.scenarios.push(result);
        console.log(JSON.stringify({ scenario: options.name, concurrency, p50: result.clientMs.p50, p95: result.clientMs.p95, pgWait: result.operations.pgWaitMs.mean, sentinel: result.sentinel, loop: result.loop }));
      }
      report.scenarios.at(-1).postgresExplainAfterLoad = await fixture.explain();
      if (profiler) {
        const { profile } = await profiler.post('Profiler.stop');
        profiler.disconnect(); profiler = null;
        const directory = join(root, 'benchmark-results'); mkdirSync(directory, { recursive: true });
        report.cpuProfile = join(directory, `history-images-${report.started.replaceAll(':', '-')}.cpuprofile`);
        writeFileSync(report.cpuProfile, JSON.stringify(profile));
      }
    }
  } catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
  finally {
    histogram?.disable();
    profiler?.disconnect();
    report.completed = new Date().toISOString();
    report.cleanupErrors = [];
    for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (error) { report.cleanupErrors.push(error.message); process.exitCode = 1; }
    const directory = join(root, 'benchmark-results'); mkdirSync(directory, { recursive: true });
    const path = join(directory, `history-latency-${report.started.replaceAll(':', '-')}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(`Report: ${path}`);
  }
}
