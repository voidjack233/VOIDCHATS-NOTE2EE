import test from 'node:test';
import assert from 'node:assert/strict';
import { services } from '../media/fixtures.js';
import { reactionScylla, reactionAuditFixture } from './reactionAuditFixture.js';
import { createReactionState } from '../../../server/reactions/state.js';
import { migrateReactions } from '../../../server/reactions/migrate.js';
import { fork } from 'node:child_process';

const cleanups = [], t = { after: fn => cleanups.push(fn) };
let storage, db;
test.before(async () => { storage = await services(t); db = await reactionScylla(t); });
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });
function consistent(state) {
  const actual = Object.fromEntries(Object.entries(state.memberships).map(([emoji, users]) => [emoji, users.length]));
  assert.deepEqual(state.counters, actual);
  assert.ok(Object.values(state.counters).every(n => n > 0));
  for (const [user, emojis] of Object.entries(state.mine)) for (const emoji of emojis) assert.ok(state.memberships[emoji].includes(user));
}
for (const present of [false, true]) for (const concurrency of [2, 10]) test(`explicit ${present ? 'REMOVE' : 'ADD'} with ${concurrency} identical requests is idempotent`, async () => {
  const f = await reactionAuditFixture(t, storage, db);
  if (present) await f.seed(['a']);
  const responses = await Promise.all(Array.from({ length: concurrency }, () => f.request('a', { method: present ? 'DELETE' : 'PUT' })));
  assert.ok(responses.every(r => r.status === 200), JSON.stringify(responses));
  const state = await f.inspect(); consistent(state); assert.equal(state.counters.a || 0, present ? 0 : 1);
  await f.drain();
  assert.equal(f.counts.publishes.length, 2);
  const event = f.counts.publishes[0].data.events.at(-1);
  assert.equal(event.revision, state.revision);
  assert.equal(event.counts.a || 0, present ? 0 : 1);
});
test('different users share one accurate count and same-user different emojis remain independent', async () => {
  const f = await reactionAuditFixture(t, storage, db, { type: 'group', members: 10 });
  assert.ok((await Promise.all(f.users.map(user => f.request('a', { user })))).every(r => r.status === 200));
  await Promise.all(['b', 'c'].map(emoji => f.request(emoji)));
  const state = await f.inspect(); consistent(state); assert.equal(state.counters.a, 10); assert.equal(state.counters.b, 1);
});
test('9->11 concurrent attempt admits exactly one new type; 10 blocks a new emoji, not an existing type', async () => {
  const f = await reactionAuditFixture(t, storage, db); await f.seed(Array.from('abcdefghi'));
  const results = await Promise.all(['x', 'y'].map(emoji => f.request(emoji)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await f.request('z')).status, 409);
  assert.equal((await f.request('a', { user: f.users[1] })).status, 200);
  const state = await f.inspect(); consistent(state); assert.equal(Object.keys(state.counters).length, 10);
});
test('unknown atomic batch outcome and response retry cannot duplicate or invert state', async () => {
  const f = await reactionAuditFixture(t, storage, db); f.faults.afterBatch = true;
  assert.equal((await f.request()).status, 503);
  consistent(await f.inspect());
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.inspect()).counters.a, 1);
  f.faults.afterBatch = true;
  assert.equal((await f.request('a', { method: 'DELETE' })).status, 503);
  assert.equal((await f.request('a', { method: 'DELETE' })).status, 200);
  assert.deepEqual((await f.inspect()).counters, {});
});
test('failure before mutation changes neither membership nor count', async () => {
  const f = await reactionAuditFixture(t, storage, db); f.faults.table = 'reaction_state';
  assert.equal((await f.request()).status, 503); assert.deepEqual((await f.inspect()).counters, {});
  assert.equal((await f.request()).status, 200); consistent(await f.inspect());
});
test('independent coordinators use Scylla CAS, not their local queues, for uniqueness', async () => {
  const f = await reactionAuditFixture(t, storage, db); await f.seed(Array.from('abcdefghi'));
  const a = createReactionState(db), b = createReactionState(db);
  const results = await Promise.allSettled([a.set(f.storageId, String(f.message), f.users[0], 'x', true), b.set(f.storageId, String(f.message), f.users[1], 'y', true)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const state = await f.inspect(); consistent(state); assert.equal(Object.keys(state.counters).length, 10);
});
test('separate Node processes cannot duplicate one membership or exceed the emoji limit', async () => {
  for (const boundary of [false, true]) {
    const f = await reactionAuditFixture(t, storage, db);
    if (boundary) await f.seed(Array.from('abcdefghi'));
    const children = [0, 1].map(i => fork(new URL('./reactionProcess.mjs', import.meta.url), [db.keyspace, f.storageId, String(f.message), f.users[0], boundary ? ['x', 'y'][i] : 'a'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
    t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill(); }));
    await Promise.all(children.map(child => new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); })));
    const results = await Promise.all(children.map(child => new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.send('go'); })));
    assert.equal(results.filter(r => r.result).length, boundary ? 1 : 2);
    const state = await f.inspect(); consistent(state); assert.equal(Object.keys(state.counters).length, boundary ? 10 : 1);
  }
});
test('rate limiting still bounds reaction spam without corrupting the accepted state', async () => {
  const f = await reactionAuditFixture(t, storage, db);
  // Exercise the actual token bucket rather than relying on its internal value format.
  const statuses = [];
  for (let i = 0; i < 85; i++) statuses.push((await f.request()).status);
  assert.ok(statuses.includes(429)); consistent(await f.inspect());
});
test('migration fails closed for an already-over-limit legacy message', async () => {
  const tasks = [], db2 = await reactionScylla({ after: fn => tasks.push(fn) });
  try {
    const f = await reactionAuditFixture(t, storage, db2); await f.seedLegacy(Array.from('abcdefghijk'));
    await db2.execute("DELETE FROM reaction_schema WHERE version='atomic_v1'");
    await assert.rejects(migrateReactions(db2, true), error => error.code === 'REACTION_LIMIT_REACHED');
    await assert.rejects(createReactionState(db2).ensureReady());
    assert.equal(Object.keys((await f.inspectLegacy(Array.from('abcdefghijk'))).counters).length, 11);
  } finally { for (const fn of tasks.reverse()) await fn(); }
});
test('history uses bounded user-specific snapshots, including non-reactors and the last removal', async () => {
  const f = await reactionAuditFixture(t, storage, db); await f.seed(['a'], f.users[1]);
  await f.seed(['b']); const before = f.counts.scylla.length;
  const data = await f.state.batch(f.storageId, [String(f.message)], f.users[0]);
  assert.equal(f.counts.scylla.length - before, 1);
  assert.equal(data.reactions[String(f.message)].a.me, false); assert.equal(data.reactions[String(f.message)].b.me, true);
  const anonymous = await f.state.batch(f.storageId, [String(f.message)]);
  assert.equal(anonymous.reactions[String(f.message)].a.count, 1);
  assert.equal(anonymous.reactions[String(f.message)].b.me, false);
  await f.state.set(f.storageId, String(f.message), f.users[1], 'a', false);
  await f.state.set(f.storageId, String(f.message), f.users[0], 'b', false);
  const empty = await f.state.batch(f.storageId, [String(f.message)], f.users[0]);
  assert.deepEqual(empty.reactions[String(f.message)], {});
  assert.equal(empty.revisions[String(f.message)], '4');
});
test('authentication, CSRF, membership, DM friendship and legacy-client rejection remain enforced', async () => {
  const f = await reactionAuditFixture(t, storage, db);
  assert.equal((await f.request('a', { body: {} })).status, 409);
  assert.equal((await f.request('a', { headerOverrides: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await f.request('a', { headerOverrides: { cookie: f.headers[f.users[0]].cookie.split('; ').slice(1).join('; ') } })).status, 401);
  await storage.pool.query("UPDATE friendships SET status='pending' WHERE requester_id=$1", [f.users[0]]);
  assert.equal((await f.request()).status, 403);
  await storage.pool.query('DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [f.logicalId, f.users[0]]);
  assert.equal((await f.request()).status, 403);
});
test('migration repairs legacy drift from memberships, verifies copy and is resumable', async () => {
  const tasks = [], db2 = await reactionScylla({ after: fn => tasks.push(fn) });
  try {
    const f = await reactionAuditFixture(t, storage, db2); await f.seedLegacy(['a', 'b']);
    await db2.execute("DELETE FROM reaction_schema WHERE version='atomic_v1'");
    await db2.execute('UPDATE reaction_counts SET count=count+9 WHERE conversation_id=? AND message_id=? AND emoji=?', [f.conv, f.message, 'a'], { prepare: true });
    assert.equal((await migrateReactions(db2, false)).copied, 2);
    await assert.rejects(createReactionState(db2).ensureReady());
    const migrated = await migrateReactions(db2, true); assert.equal(migrated.verified, 2);
    consistent(await f.inspect()); assert.equal((await f.inspect()).counters.a, 1);
    assert.equal((await migrateReactions(db2, true)).alreadyReady, true);
  } finally { for (const fn of tasks.reverse()) await fn(); }
});
