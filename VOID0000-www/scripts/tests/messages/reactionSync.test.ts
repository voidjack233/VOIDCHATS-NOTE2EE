import test from 'node:test';
import assert from 'node:assert/strict';
import { ReactionSync, type ReactionSnapshot, type ReactionMap } from '../../../src/Services/Chat/reactionSync';

const snapshot = (revision: number, mine: string[] = ['a'], counts: Record<string, number> = { a: 1 }, actor = 'u'): ReactionSnapshot => ({ conversation_id: 'c', message_id: 'm', user_id: actor, revision: String(revision), counts, mine });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let view: Record<string, ReactionMap> = {}, renders = 0;
  const requests: Array<{ present: boolean; resolve: (data: ReactionSnapshot) => void; reject: (error: unknown) => void }> = [], errors: unknown[] = [];
  const controller = new ReactionSync('c', 'u', (_m, _e, present) => new Promise((resolve, reject) => requests.push({ present, resolve, reject })), next => { view = next; renders++; }, error => errors.push(error));
  controller.seed([{ message_id: 'm', reactions: {}, reaction_revision: '0' }]);
  t.after(() => controller.dispose());
  return { controller, requests, errors, view: () => view, renders: () => renders, async tick(ms = 220) { t.mock.timers.tick(ms); await settle(); } };
}
test('rapid add/remove/add is one explicit ADD; optimistic state is immediate', async t => {
  const f = fixture(t); f.controller.toggle('m', 'a'); f.controller.toggle('m', 'a'); f.controller.toggle('m', 'a');
  assert.deepEqual(f.view().m.a, { count: 1, me: true });
  await f.tick(); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].present, true);
  f.requests[0].resolve(snapshot(1)); await settle(); assert.deepEqual(f.view().m.a, { count: 1, me: true });
});
test('rapid add/remove needs no HTTP request', async t => {
  const f = fixture(t); f.controller.toggle('m', 'a'); f.controller.toggle('m', 'a'); await f.tick();
  assert.equal(f.requests.length, 0); assert.deepEqual(f.view().m, {});
});
test('older success cannot invert intent changed while in flight', async t => {
  const f = fixture(t); f.controller.toggle('m', 'a'); await f.tick(); f.controller.toggle('m', 'a');
  f.requests[0].resolve(snapshot(1)); await settle(); assert.deepEqual(f.view().m, {});
  await f.tick(); assert.equal(f.requests[1].present, false);
  f.requests[1].resolve(snapshot(2, [], {})); await settle(); assert.deepEqual(f.view().m, {});
});
test('unknown ADD outcome followed by REMOVE must send explicit compensation', async t => {
  const f = fixture(t); f.controller.toggle('m', 'a'); await f.tick(); f.controller.toggle('m', 'a');
  f.requests[0].reject({ status: 503 }); await settle(); await f.tick(250);
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].present, false);
  f.requests[1].resolve(snapshot(2, [], {})); await settle(); assert.deepEqual(f.view().m, {});
});
test('gateway own echo and older HTTP response are not additive or authoritative over newer snapshots', async t => {
  const f = fixture(t); f.controller.toggle('m', 'a'); await f.tick();
  f.controller.receive([snapshot(1), snapshot(2, ['a'], { a: 2 }, 'other')]);
  f.requests[0].resolve(snapshot(1)); await settle(); assert.deepEqual(f.view().m.a, { count: 2, me: true });
  const before = f.renders(); f.controller.receive([snapshot(1), snapshot(2, ['a'], { a: 2 }, 'other')]);
  assert.equal(f.renders(), before);
});
test('two tabs converge from actor snapshots including remove and reordered events', t => {
  const f = fixture(t); let otherView: Record<string, ReactionMap> = {};
  const other = new ReactionSync('c', 'u', async () => snapshot(1), next => { otherView = next; }); t.after(() => other.dispose());
  for (const controller of [f.controller, other]) controller.receive([snapshot(2, [], {}), snapshot(1)]);
  assert.deepEqual(f.view().m, {}); assert.deepEqual(otherView.m, {});
});
test('an old response does not reassert an intent superseded by another tab', async t => {
  const f = fixture(t); f.controller.toggle('m', 'a'); await f.tick();
  f.controller.receive([snapshot(2, [], {})]);
  f.requests[0].resolve(snapshot(1)); await settle(); await f.tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.view().m, {});
});
test('batch snapshots update React once and ignore other conversations', t => {
  const f = fixture(t), before = f.renders();
  f.controller.receive([snapshot(1), snapshot(2, ['a'], { a: 2 }, 'other'), { ...snapshot(100), conversation_id: 'different' }]);
  assert.equal(f.renders() - before, 1); assert.equal(f.view().m.a.count, 2);
});
for (const status of [425, 429, 503]) test(`${status} retries explicit desired state with bounded backoff`, async t => {
  const f = fixture(t); f.controller.toggle('m', 'a'); await f.tick();
  for (const wait of [250, 500, 1000]) { f.requests.at(-1)!.reject({ status }); await settle(); await f.tick(wait); }
  assert.equal(f.requests.length, 4); assert.ok(f.requests.every(r => r.present));
  f.requests.at(-1)!.reject({ status }); await settle(); await f.tick(60_000);
  assert.equal(f.requests.length, 4); assert.equal(f.errors.length, 1);
});
test('empty newer history snapshot clears state; older history cannot overwrite a live update', t => {
  const f = fixture(t); f.controller.receive([snapshot(2)]);
  f.controller.seed([{ message_id: 'm', reactions: {}, reaction_revision: '1' }]); assert.equal(f.view().m.a.count, 1);
  f.controller.seed([{ message_id: 'm', reactions: {}, reaction_revision: '3' }]); assert.deepEqual(f.view().m, {});
});
test('dispose cancels delayed work and ignores late responses', async t => {
  const f = fixture(t); f.controller.toggle('m', 'a'); f.controller.dispose(); await f.tick(); assert.equal(f.requests.length, 0);
});
