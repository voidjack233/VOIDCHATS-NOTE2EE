import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pool } from '../../../server/db.js';
import valkey from '../../../server/valkey.js';
import { sessionStore } from '../../../server/auth/services/sessionService.js';
import { revokeCredentialRecords } from '../../../server/auth/services/credentialInvalidation.js';
import { canPerformGroupOperation } from '../../../server/utils/groupPermissions.js';
import { canInteractInConversation } from '../../../server/utils/conversationInteraction.js';
import { getClientIP } from '../../../server/utils/securityUtils.js';
import { validatePushSubscription, withPushCapacity } from '../../../server/notifications/pushTransport.js';
import changePassword from '../../../server/auth/routes/change-password.js';
import { Client as MinioClient } from 'minio';
import { setupLifecycleFixture, transaction, issue } from './sessionLifecycleFixture.js';

// Requires an isolated test database/Valkey, never the configured application DB.
if (process.env.PGPORT !== '15439' || process.env.VALKEY_PORT !== '16389') {
  throw new Error('Run with the isolated security-test PostgreSQL/Valkey ports (15439/16389)');
}
let fixture;
before(async () => { fixture = await setupLifecycleFixture(); });
after(async () => { await fixture?.close(); });

test('atomic validate/touch do not recreate sessions after revoke or revoke-all', async () => {
  const account = await fixture.user(); const user = account.id; const device = randomUUID();
  const first = await issue(account, device);
  await Promise.all([sessionStore.validate(user, device, first.sessionId), transaction(client=>sessionStore.revoke(user, device, client))]);
  assert.equal(await sessionStore.validate(user, device, first.sessionId), null);
  assert.equal(await sessionStore.touch(user, device, first.sessionId), false);
  assert.equal(await valkey.exists(`session:${user}:${device}`), 0);
  const second = await issue(account, device);
  await Promise.all([sessionStore.touch(user, device, second.sessionId), transaction(client=>sessionStore.revokeAll(user, client))]);
  assert.equal(await valkey.exists(`session:${user}:${device}`), 0);
  assert.deepEqual(await valkey.smembers(`user_sessions:${user}`), []);
});

test('SQL-to-cache recovery waits for revocation and cannot resurrect its stale observation', async () => {
  const account = await fixture.user(); const user = account.id; const device = randomUUID();
  const session = await issue(account, device);
  const revoke = await pool.connect();
  try {
    await revoke.query('BEGIN');
    await revoke.query('UPDATE refresh_tokens SET is_revoked=TRUE WHERE user_id=$1', [user]);
    let settled = false;
    await valkey.del(`session:${user}:${device}`);
    const recovery = sessionStore.create(user, device, session.sessionId).then((result) => { settled = true; return result; });
    await delay(30);
    assert.equal(settled, false);
    await revoke.query('COMMIT');
    assert.equal(await recovery, null);
    assert.equal(await valkey.exists(`session:${user}:${device}`), 0);
  } finally { await revoke.query('ROLLBACK'); revoke.release(); }
});

test('credential replacement revokes every device and removes reset links atomically', async () => {
  const account = await fixture.user(); const user = account.id;
  await issue(account, 'a'); await issue(account, 'b');
  await pool.query('INSERT INTO password_resets(user_id) VALUES($1)', [user]);
  await transaction(client=>revokeCredentialRecords(client, user));
  const tokens = await pool.query('SELECT is_revoked FROM refresh_tokens WHERE user_id=$1', [user]);
  assert.ok(tokens.rows.every((row) => row.is_revoked));
  assert.equal((await pool.query('SELECT * FROM password_resets WHERE user_id=$1', [user])).rowCount, 0);
});

test('password-change budget stops attempts before connection acquisition or verification', async (t) => {
  let connections = 0;
  t.mock.method(pool, 'connect', async () => { connections++; throw new Error('test verification boundary'); });
  t.mock.method(pool, 'query', async () => ({ rows: [] }));
  t.mock.method(console, 'error', () => {});
  const handler = changePassword.stack.find((layer) => layer.route).route.stack.at(-1).handle;
  const req = { user: { id: randomUUID() }, body: { currentPassword: 'wrong', newPassword: 'New-example-pass-987!' },
    headers: {}, cookies: {}, ip: '127.0.0.1', get: () => '', socket: { remoteAddress: '127.0.0.1' } };
  const responses = await Promise.all(Array.from({ length: 20 }, async () => {
    const res = { statusCode: 200, status(code) { this.statusCode=code; return this; }, json(body) { this.body=body; return this; }, set() { return this; } };
    await handler(req, res); return res;
  }));
  assert.equal(connections, 5);
  assert.equal(responses.filter((res) => res.statusCode === 429).length, 15);
});

test('group audience and role switches cannot override each other', () => {
  for (const [operation, toggle, audience] of [
    ['profile', 'admin_can_edit_group_profile', 'who_can_edit_group_profile'],
    ['otherNickname', 'admin_can_edit_member_nicknames', 'who_can_edit_other_nicknames'],
    ['invites', 'admin_can_manage_invite_links', 'who_can_create_invite_links'],
    ['approvals', 'admin_can_approve_join_requests', 'who_can_approve_requests'],
  ]) {
    assert.equal(canPerformGroupOperation('admin', { [toggle]: false }, operation), false);
    assert.equal(canPerformGroupOperation('admin', { [toggle]: true, [audience]: 'owner' }, operation), false);
    assert.equal(canPerformGroupOperation('owner', { [toggle]: false }, operation), true);
    assert.equal(canPerformGroupOperation('admin', null, operation), true);
    assert.equal(canPerformGroupOperation('viewer', { [audience]: 'everyone' }, operation), false);
  }
});

test('group profile route rejects owner-disabled admin changes before any mutation', async (t) => {
  t.mock.method(MinioClient.prototype, 'bucketExists', async () => true);
  t.mock.method(MinioClient.prototype, 'setBucketPolicy', async () => {});
  const { default: updateGroup } = await import('../../../server/routes/conversations/root/update.js');
  const queries = [];
  t.mock.method(pool, 'query', async (sql) => {
    queries.push(sql);
    if (sql.includes('FROM conversations')) return { rows: [{ id: '123', type: 'group', permissions: { admin_can_edit_group_profile: false } }] };
    if (sql.includes('FROM conversation_members')) return { rows: [{ role: 'admin' }] };
    throw new Error('unexpected mutation');
  });
  const handler = updateGroup.stack.find((layer) => layer.route).route.stack.at(-1).handle;
  const res = { code: 200, status(code) { this.code=code; return this; }, json() { return this; } };
  await handler({ params: { conversationId: '123' }, user: { id: 'admin' }, body: { name: 'not authorized' } }, res);
  assert.equal(res.code,403);
  assert.equal(queries.length,2);
});

test('DM interaction requires current accepted friendship, group membership policy remains independent', async () => {
  const db = { async query(sql, values) {
    assert.match(sql, /f.status = 'accepted'/);
    assert.match(sql, /\$2::uuid IN \(dp.user_a, dp.user_b\)/);
    assert.deepEqual(values, ['conversation', 'sender']);
    return { rows: [] };
  } };
  assert.equal(await canInteractInConversation(db, { id: 'conversation', type: 'dm' }, 'sender'), false);
  assert.equal(await canInteractInConversation({ query: async () => ({ rows: [{}] }) }, { id: 'c', type: 'dm' }, 'u'), true);
  assert.equal(await canInteractInConversation({ query() { throw new Error('unexpected'); } }, { id: 'c', type: 'group' }, 'u'), true);
});

test('untrusted forwarding headers cannot change the security IP identity', () => {
  for (const headers of [{}, { 'cf-connecting-ip': '1.2.3.4' }, { 'x-forwarded-for': '8.8.8.8' }]) {
    assert.equal(getClientIP({ headers, ip: '192.0.2.15', socket: { remoteAddress: '127.0.0.1' } }), '192.0.2.15');
  }
});

test('push subscriptions reject arbitrary destinations and malformed keys', () => {
  const keys = { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') };
  for (const endpoint of ['https://127.0.0.1/push', 'https://example.com/push', 'https://fcm.googleapis.com.evil.test/push', 'https://user@fcm.googleapis.com/push', 'http://fcm.googleapis.com/push', 'https://fcm.googleapis.com:444/push']) {
    assert.throws(() => validatePushSubscription({ endpoint, keys }), { status: 400 });
  }
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/test', 'https://updates.push.services.mozilla.com/wpush/v2/test', 'https://web.push.apple.com/test']) {
    assert.equal(validatePushSubscription({ endpoint, keys }).endpoint, endpoint);
    assert.throws(() => validatePushSubscription({ endpoint, keys: { ...keys, auth: 'wrong' } }));
  }
});

test('push delivery has bounded active and waiting work and recovers after failures', async () => {
  let active=0, peak=0;
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const results = Promise.allSettled(Array.from({ length: 100 }, () => withPushCapacity(async () => {
    active++; peak=Math.max(peak,active);
    await gate; active--; throw new Error('simulated provider failure');
  })));
  await delay(10);
  assert.equal(peak,8);
  release();
  const settled=await results;
  assert.equal(settled.filter((item) => item.reason?.message === 'Push delivery queue full').length,28);
  assert.equal(await withPushCapacity(async () => 'healthy'), 'healthy');
});
