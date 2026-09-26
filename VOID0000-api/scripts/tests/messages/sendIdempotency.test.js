import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { services, until } from '../media/fixtures.js';
import { sendAuditFixture } from './sendAuditFixture.js';
import { createPostgresAttachmentReservationStore } from '../../../server/attachments/reservationReconciliation.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { claimMessageSend } from '../../../server/routes/conversations/messages/sendOperation.js';
import { measurePush } from './pushAuditFixture.js';

let storage, cleanup;
before(async () => { storage = await services({ after: fn => { cleanup = fn; } }, { poolMax: 4 }); });
after(async () => cleanup?.());

for (const images of [0, 1]) for (const count of [2, 10]) {
  test(`${count} concurrent identical ${images ? 'attachment' : 'text'} POSTs accept once; sequential retry is canonical`, async t => {
    const f = await sendAuditFixture(t, storage, { images });
    const body = { client_message_id: randomUUID(), attachments: f.attachments };
    const results = await Promise.all(Array.from({ length: count }, () => f.request(body)));
    assert.ok(results.every(r => r.status === 201 || r.status === 425), JSON.stringify(results));
    assert.equal(f.rows.size, 1); assert.equal(await f.unread(), 1);
    const ids = new Set(results.filter(r => r.status === 201).map(r => r.body.message.message_id));
    assert.equal(ids.size, 1);
    await f.resetLimits();
    assert.equal((await f.request(body)).body.message.message_id, [...ids][0]);
    assert.equal(await f.unread(), 1); assert.equal(f.counts.publishes.length, 2); assert.equal(f.counts.push, 1);
    const mismatch = await f.request({ ...body, content: 'different payload' });
    assert.equal(mismatch.status, 409);
  });
}

for (const images of [0, 1]) for (const [fault, value] of [
  ['scylla', 'before'], ['scylla', 'after'], ['pg', true], ['commit', 'applied'], ['commit', 'not-applied'],
  ['delivery', true], ['recipients', true],
]) {
  test(`${images ? 'attachment' : 'text'} retry after ${fault}:${value} retains one ID and unread effect`, async t => {
    const f = await sendAuditFixture(t, storage, { images });
    const body = { client_message_id: randomUUID(), attachments: f.attachments };
    f.faults[fault] = value;
    assert.equal((await f.request(body)).status, 500);
    const operation = (await storage.pool.query('SELECT * FROM message_send_operations WHERE user_id=$1', [f.user])).rows[0];
    assert.ok(operation);
    if (fault === 'commit' && value === 'applied') { assert.equal(await f.unread(), 1); assert.equal(f.rows.size, 1); }
    const retried = await f.request(body);
    assert.equal(retried.status, 201, JSON.stringify(retried));
    assert.equal(retried.body.message.message_id, operation.message_id);
    assert.equal(f.rows.size, 1); assert.equal(await f.unread(), 1);
    assert.equal(f.counts.publishes.length, 2); assert.equal(f.counts.push, 1);
    if (images) assert.equal((await storage.pool.query('SELECT status FROM attachment_objects WHERE uploader_id=$1', [f.user])).rows[0].status, 'committed');
    assert.equal(f.counts.scylla.filter(c => c.sql.startsWith('DELETE')).length, 0);
  });
}

test('cache loss after acceptance is not authority; different users and keys stay independent', async t => {
  const f = await sendAuditFixture(t, storage);
  const body = { client_message_id: randomUUID() };
  const first = await f.request(body); assert.equal(first.status, 201);
  f.faults.cache = true;
  assert.equal((await f.request(body)).body.message.message_id, first.body.message.message_id);
  f.faults.cache = false;
  assert.equal((await f.request(body, f.peer)).status, 201);
  assert.equal((await f.request({ client_message_id: randomUUID() })).status, 201);
  assert.equal(f.rows.size, 3);
  const other = randomUUID();
  await storage.pool.query("INSERT INTO conversations(id,type,owner_id) VALUES($1,'group',$2)", [other, f.user]);
  const child = randomUUID();
  await storage.pool.query("INSERT INTO conversations(id,type,parent_conversation_id,name) VALUES($1,'channel',$2,'general')", [child, other]);
  await storage.pool.query("INSERT INTO conversation_members(conversation_id,user_id,role) VALUES($1,$2,'member')", [other, f.user]);
  assert.equal((await f.request(body, f.user, other)).status, 201);
  assert.equal(f.rows.size, 4);
});

test('more independent attachment sends than pool slots cannot nest pool acquisition', async t => {
  const fixtures = [];
  for (let i = 0; i < 10; i++) fixtures.push(await sendAuditFixture(t, storage, { images: 1 }));
  const responses = await Promise.all(fixtures.map(f => f.request({ client_message_id: randomUUID(), attachments: f.attachments })));
  assert.ok(responses.every(r => r.status === 201), JSON.stringify(responses));
});

test('pending acknowledged operation fences cleanup; positive worker reconciliation still permits send recovery', async t => {
  const f = await sendAuditFixture(t, storage, { images: 1 });
  f.faults.pg = true;
  const body = { client_message_id: randomUUID(), attachments: f.attachments };
  assert.equal((await f.request(body)).status, 500);
  await storage.pool.query("UPDATE attachment_objects SET reserved_until=NOW()-INTERVAL '1 minute' WHERE uploader_id=$1", [f.user]);
  const store = createPostgresAttachmentReservationStore({ dbPool: storage.pool, freshStagedTtlSeconds: 60 });
  const group = (await store.listExpiredReservationGroups(100)).find(g => g.uploaderId === f.user);
  assert.equal(group.scyllaWriteAcknowledged, true);
  await assert.rejects(store.releaseToStaged(group));
  assert.equal((await storage.pool.query('SELECT status FROM attachment_objects WHERE uploader_id=$1', [f.user])).rows[0].status, 'reserved');
  assert.equal(await store.markCommitted(group), true);
  assert.equal((await f.request(body)).status, 201);
  assert.equal(await f.unread(), 1); assert.equal(f.rows.size, 1);
});

test('failed acknowledgement, malformed/unavailable reads and mismatches cannot release an uncertain reservation', async t => {
  const f = await sendAuditFixture(t, storage, { images: 1 });
  const body = { client_message_id: randomUUID(), attachments: f.attachments };
  f.faults.ack = true;
  assert.equal((await f.request(body)).status, 500);
  const state = async () => (await storage.pool.query('SELECT status,scylla_write_acknowledged_at FROM attachment_objects WHERE uploader_id=$1', [f.user])).rows[0];
  assert.equal((await state()).scylla_write_acknowledged_at, null);
  for (const fault of ['malformed', 'read']) {
    f.faults[fault] = true;
    assert.equal((await f.request(body)).status, 500);
    assert.equal((await state()).status, 'reserved');
    f.faults[fault] = false;
  }
  const row = [...f.rows.values()][0], attachments = row.attachments;
  row.attachments = [];
  assert.equal((await f.request(body)).status, 409);
  assert.equal((await state()).status, 'reserved'); assert.equal(await f.unread(), 0);
  row.attachments = attachments;
  assert.equal((await f.request(body)).status, 201);
  assert.equal((await state()).status, 'committed');
  assert.equal((await state()).scylla_write_acknowledged_at, null, 'positive recovery read must not pretend an INSERT was acknowledged');
});

test('completed retry preserves later edits and never recreates a missing accepted row', async t => {
  const f = await sendAuditFixture(t, storage);
  const body = { client_message_id: randomUUID() };
  assert.equal((await f.request(body)).status, 201);
  const row = [...f.rows.values()][0]; row.content = 'edited'; row.is_edited = true;
  const retry = await f.request(body);
  assert.equal(retry.body.message.content, 'edited'); assert.equal(retry.body.message.is_edited, true);
  f.rows.clear(); assert.equal((await f.request(body)).status, 503);
  assert.equal(f.rows.size, 0); assert.equal(await f.unread(), 1);
});

test('independent Node processes share the claim and process death releases lock without losing canonical ID', async t => {
  const f = await sendAuditFixture(t, storage), clientMessageId = randomUUID();
  const options = { userId: f.user, conversationId: f.conversation, storageConversationId: f.conversation,
    clientMessageId, payload: { content: 'test' }, newMessageId: randomUUID() };
  const child = fork(new URL('./sendOperationProcess.mjs', import.meta.url), [], { execArgv: ['--import', 'tsx'], env: storage.env, silent: true });
  t.after(() => child.kill());
  child.send(options);
  const [claimed] = await once(child, 'message');
  assert.equal(claimed.messageId, options.newMessageId, JSON.stringify(claimed));
  await assert.rejects(claimMessageSend({ ...options, dbPool: storage.pool, restoreLegacy: async () => null }), { code: 'MESSAGE_SEND_IN_PROGRESS' });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  let retry;
  await until(async () => {
    try { retry = await claimMessageSend({ ...options, newMessageId: randomUUID(), dbPool: storage.pool, restoreLegacy: async () => null }); return true; }
    catch (error) { if (error.code === 'MESSAGE_SEND_IN_PROGRESS') return false; throw error; }
  }, 2000);
  try { assert.equal(retry.row.message_id, claimed.messageId); assert.equal(retry.resumed, true); }
  finally { await retry.close(); }
});

test('push dispatcher batches discovery, caps subscriptions, bounds delivery and records failures per subscription', async t => {
  const f = await sendAuditFixture(t, storage, { type: 'group', members: 10 });
  const success = await measurePush(storage, f, 12);
  assert.equal(success.reads, 2); assert.equal(success.deliveries, 90); assert.equal(success.updates, 90); assert.equal(success.peak, 8);
  const failed = await measurePush(storage, f, 12, true);
  assert.equal(failed.reads, 2); assert.equal(failed.deliveries, 90); assert.equal(failed.updates, 90); assert.equal(failed.peak, 8);
});

test('cache SET failure cannot lose the authoritative operation or multiply acceptance', async t => {
  const f = await sendAuditFixture(t, storage), body = { client_message_id: randomUUID() };
  f.faults.cacheSet = true;
  const first = await f.request(body); assert.equal(first.status, 201);
  assert.equal(await storage.redis.get(`message:idempotency:${f.user}:${f.conversation}:${body.client_message_id}`), null);
  assert.equal((await f.request(body)).body.message.message_id, first.body.message.message_id);
  assert.equal(await f.unread(), 1); assert.equal(f.rows.size, 1); assert.equal(f.counts.push, 1);
});

test('failure after fanout never repeats acceptance; replayed events retain their deduplication identity', async t => {
  const f = await sendAuditFixture(t, storage), body = { client_message_id: randomUUID() };
  f.faults.effects = true;
  assert.equal((await f.request(body)).status, 500);
  const id = String([...f.rows.values()][0].message_id);
  assert.equal((await f.request(body)).body.message.message_id, id);
  assert.equal(f.rows.size, 1); assert.equal(await f.unread(), 1);
  assert.equal(f.counts.publishes.length, 4); assert.equal(new Set(f.counts.eventIds).size, 1);
  assert.equal(f.counts.push, 2, 'best-effort notification scheduling is not exactly-once delivery');
  await storage.pool.query("UPDATE conversation_members SET role='viewer' WHERE conversation_id=$1 AND user_id=$2", [f.conversation, f.user]);
  assert.equal((await f.request(body)).status, 403, 'a durable operation never bypasses current authorization');
});

test('replacing group storage cannot erase a logical conversation claim or mint a replacement message', async t => {
  const f = await sendAuditFixture(t, storage, { type: 'group' });
  const body = { client_message_id: randomUUID() };
  const first = await f.request(body); assert.equal(first.status, 201);
  await storage.pool.query('DELETE FROM conversations WHERE id=$1', [f.child]);
  await storage.pool.query("INSERT INTO conversations(id,type,parent_conversation_id,name) VALUES($1,'channel',$2,'general')", [randomUUID(), f.conversation]);
  const retry = await f.request(body);
  assert.equal(retry.status, 409);
  const records = await storage.pool.query('SELECT message_id FROM message_send_operations WHERE user_id=$1', [f.user]);
  assert.equal(records.rowCount, 1); assert.equal(records.rows[0].message_id, first.body.message.message_id);
  assert.equal(f.rows.size, 1); assert.equal(await f.unread(), 1);
});
