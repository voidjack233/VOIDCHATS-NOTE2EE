import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { services, root } from './tests/media/fixtures.js';
import { reactionAuditFixture, reactionScylla } from './tests/messages/reactionAuditFixture.js';
import { measureReactionHistory } from './tests/messages/reactionHistoryMeasure.js';

if (!process.argv.includes('--local-scylla')) throw new Error('Require --local-scylla: only a new disposable keyspace is used');
if (!process.argv.includes('--fixed')) throw new Error('Current source requires --fixed; baseline evidence was collected before the fix');
const cleanups = [], t = { after: fn => cleanups.push(fn) };
const report = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), started: new Date().toISOString(), races: [], failures: [], scenarios: [] };
report.mode = 'fixed-working-tree';
report.workingTree = execFileSync('git', ['status', '--short'], { encoding: 'utf8' });
try {
  const storage = await services(t, { poolMax: 10 }), scylla = await reactionScylla(t);
  for (const present of [false, true]) for (const concurrent of [2, 10]) {
    const f = await reactionAuditFixture(t, storage, scylla);
    if (present) await f.seed(['a']);
    const responses = await Promise.all(Array.from({ length: concurrent }, () => f.request('a', { method: present ? 'DELETE' : 'PUT' })));
    await f.drain();
    const result = { present, concurrent, statuses: responses.map(r => r.status), state: await f.inspect(), counts: f.counts };
    report.races.push(result); console.log(JSON.stringify({ present, concurrent, state: result.state }));
  }
  for (const initial of [9, 10]) {
    const f = await reactionAuditFixture(t, storage, scylla);
    const emojis = Array.from({ length: initial }, (_, i) => String.fromCharCode(97 + i)); await f.seed(emojis);
    const responses = await Promise.all(['x', 'y'].map(emoji => f.request(emoji)));
    await f.drain(); report.races.push({ initial, statuses: responses.map(r => r.status), state: await f.inspect([...emojis, 'x', 'y']) });
  }
  for (const table of ['before-batch', 'after-batch']) {
    const f = await reactionAuditFixture(t, storage, scylla);
    if (table === 'before-batch') f.faults.table = 'reaction_state'; else f.faults.afterBatch = true;
    const response = await f.request(); const partial = await f.inspect();
    const retry = await f.request(); await f.drain();
    report.failures.push({ table, status: response.status, partial, retryStatus: retry.status, retried: await f.inspect() });
  }
  for (const action of ['add-new', 'add-existing', 'remove']) {
    const f = await reactionAuditFixture(t, storage, scylla);
    if (action !== 'add-new') await f.seed(['a'], action === 'remove' ? f.users[0] : f.users[1]);
    const response = await f.request('a', { method: action === 'remove' ? 'DELETE' : 'PUT' }); await f.drain(); report.scenarios.push({ action, response, counts: f.counts });
  }
  for (const size of [10, 100, 500]) {
    const f = await reactionAuditFixture(t, storage, scylla, { members: size, type: 'group' });
    const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
    const responses = await Promise.all(f.users.map(user => f.request('a', { user })));
    await f.drain(); loop.disable();
    const result = { size, ms: responses.map(r => r.ms), statuses: responses.map(r => r.status), loopMaxMs: loop.max / 1e6, state: await f.inspect(), counts: f.counts };
    report.scenarios.push(result); console.log(JSON.stringify({ size, publishes: f.counts.publishes.length, queued: f.counts.events.length, loopMaxMs: result.loopMaxMs, p50: result.ms.toSorted((a, b) => a - b)[Math.floor(size / 2)] }));
  }
  report.history = await measureReactionHistory(scylla);
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
finally {
  report.cleanupErrors = [];
  for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (error) { report.cleanupErrors.push(error.message); process.exitCode = 1; }
  mkdirSync(join(root, 'benchmark-results'), { recursive: true });
  const file = join(root, 'benchmark-results', `reaction-audit-${report.started.replaceAll(':', '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2)); console.log(file);
}
