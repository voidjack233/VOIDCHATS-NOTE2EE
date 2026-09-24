import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import cassandra from 'cassandra-driver';
import { load, services, until } from '../media/fixtures.js';
import { Sentinel, createSentinelKey } from '../../../server/sentinel/index.js';
import * as deliveryCore from '../../../server/utils/attachmentDeliveryCore.js';
import * as policy from '../../../server/utils/attachmentContentPolicy.js';
import * as lifecycle from '../../../server/attachments/lifecycleCore.js';
import * as consistency from '../../../server/attachments/messageConsistency.js';
import * as editPolicy from '../../../server/attachments/editPolicy.js';
import * as permissions from '../../../server/utils/groupPermissions.js';
import * as interaction from '../../../server/utils/conversationInteraction.js';
import * as identity from '../../../server/utils/eventIdentity.js';
import * as account from '../../../server/auth/middleware/requestAccount.js';
import { RATE_LIMIT_POLICIES } from '../../../server/middleware/rateLimits/policies.js';
import * as algorithms from '../../../server/middleware/rateLimits/algorithms.js';

let storage, cleanup;
before(async () => { storage = await services({ after: fn => { cleanup = fn; } }); });
after(async () => { await cleanup?.(); });
const esm = value => ({ __esModule: true, default: value });

async function fixture(t, { images = 0, type = 'dm' } = {}) {
  const counts = { postgres: [], scylla: [], valkey: [], minio: 0 };
  const redis = new Proxy(storage.redis, { get(target, method) {
    if (method === 'pipeline') return () => {
      const pipeline = target.pipeline();
      let proxy;
      proxy = new Proxy(pipeline, { get(p, command) {
        if (command === 'exec') return () => p.exec();
        return (...args) => { counts.valkey.push({ command, key: args[0] }); p[command](...args); return proxy; };
      } });
      return proxy;
    };
    return (...args) => { counts.valkey.push({ command: method, key: method === 'eval' ? args[2] : args[0] }); return target[method](...args); };
  } });
  const pool = { async query(sql, args) { counts.postgres.push(sql); return storage.pool.query(sql, args); },
    async connect() {
      const client = await storage.pool.connect();
      return { query(sql, args) { counts.postgres.push(sql); return client.query(sql, args); }, release: () => client.release() };
    } };
  const user = randomUUID(), peer = randomUUID(), stranger = randomUUID(), conversation = randomUUID(), child = randomUUID();
  for (const id of [user, peer, stranger]) await storage.pool.query(
    'INSERT INTO users(id,username,email,password_hash) VALUES($1,$2,$3,$4)', [id, id, `${id}@test.invalid`, 'unused']);
  await storage.pool.query('INSERT INTO conversations(id,type,owner_id) VALUES($1,$2,$3)', [conversation, type, user]);
  if (type === 'group') await storage.pool.query(
    "INSERT INTO conversations(id,type,parent_conversation_id,name) VALUES($1,'channel',$2,'general')", [child, conversation]);
  for (const id of [user, peer]) await storage.pool.query(
    "INSERT INTO conversation_members(conversation_id,user_id,role) VALUES($1,$2,'member')", [conversation, id]);
  if (type === 'dm') {
    await storage.pool.query('INSERT INTO dm_pairs(conversation_id,user_a,user_b) VALUES($1,$2,$3)', [conversation, ...[user, peer].sort()]);
    await storage.pool.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES($1,$2,'accepted')", [user, peer]);
  }
  const attachmentIds = [];
  for (let i = 0; i < images; i++) {
    const hash = createHash('sha256').update(`${conversation}:${i}`).digest('hex');
    const blob = await storage.pool.query(`INSERT INTO attachment_blobs(content_hash,bucket,object_key,size_bytes,content_type,inline,status)
      VALUES($1,'attachments',$2,100,'image/jpeg',true,'ready') RETURNING id`, [hash, lifecycle.createAttachmentBlobObjectKey(hash)]);
    const attachment = await storage.pool.query(`INSERT INTO attachment_objects(conversation_id,uploader_id,blob_id,filename,bucket,object_key)
      VALUES($1,$2,$3,'image.jpg','attachments',$4) RETURNING id`, [conversation, user, blob.rows[0].id, lifecycle.createAttachmentBlobObjectKey(hash)]);
    attachmentIds.push(attachment.rows[0].id);
  }
  const rows = Array.from({ length: 21 }, (_, i) => ({
    conversation_id: cassandra.types.Uuid.fromString(type === 'group' ? child : conversation),
    message_id: cassandra.types.TimeUuid.now(), sender_id: cassandra.types.Uuid.fromString(user),
    content: `message ${i}`, created_at: new Date(), is_deleted: false,
    attachments: attachmentIds[i] ? [JSON.stringify({ url: `/api/conversations/${conversation}/attachments/${attachmentIds[i]}`, mime: 'image/jpeg' })] : [],
  }));
  let holdHistory;
  const scylla = { async execute(sql, args, options) {
    counts.scylla.push({ sql, args, options });
    if (/FROM messages/.test(sql)) { if (holdHistory) await holdHistory; return { rows: sql.includes('message_id =') ? [rows[0]] : rows }; }
    if (/FROM reaction_counts/.test(sql)) return { rows: [{ message_id: rows[0].message_id, emoji: 'like', count: 2 }] };
    if (/FROM user_reactions/.test(sql)) return { rows: String(args[1]) === user ? [{ message_id: rows[0].message_id, emoji: 'like' }] : [] };
    if (/INSERT INTO messages/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected Scylla operation: ${sql}`);
  } };
  const sentinel = new Sentinel();
  const db = { pool };
  const shared = load('routes/conversations/messages/shared', {
    '../../../db.js': db, '../../../scylla.js': { ...esm(scylla), cassandra },
    '../../../utils/conversationIdentity.js': load('utils/conversationIdentity', { '../db.js': db }),
    '../../../utils/messageConversation.js': load('utils/messageConversation', { '../db.js': db }),
  });
  const capability = load('vmd/capability', {}, { VMD_SIGNING_SECRET: 'test-only-'.repeat(8), VMD_PUBLIC_URL: 'https://vmd.invalid' });
  const delivery = load('utils/attachmentDelivery', {
    '../db.js': db, '../minio.js': { ATTACH_BUCKET: 'attachments', cdnMinioClient: storage.objects,
      minioClient: { statObject() { counts.minio++; throw new Error('Finalized images must not stat'); } } },
    '../vmd/capability.js': capability, './attachmentContentPolicy.js': policy, './attachmentDeliveryCore.js': deliveryCore,
  });
  const gateway = { sendLiveEventToUser() {} }, debug = { debugLog() {} };
  const deps = { './shared.js': shared, '../../../utils/attachmentDelivery.js': delivery,
    '../../../gateway/client.js': gateway, '../../../utils/debugLog.js': debug };
  const history = load('routes/conversations/messages/history', { ...deps,
    '../../../sentinel/index.js': { ...esm(sentinel), createSentinelKey } }).default;
  const lifecycleInstance = lifecycle.createAttachmentLifecycle({ dbPool: pool, objectStore: storage.objects, bucket: 'attachments' });
  const send = load('routes/conversations/messages/sendMessage', { ...deps,
    '../../../utils/conversationInteraction.js': interaction, '../../../utils/groupPermissions.js': permissions,
    '../../../attachments/lifecycle.js': { ...lifecycle, attachmentLifecycle: lifecycleInstance },
    '../../../attachments/messageConsistency.js': consistency, '../../../utils/eventIdentity.js': identity,
    '../../../notifications/webPush.js': { dispatchMessagePushNotifications() {} }, '../../../valkey.js': esm(redis),
  });
  const create = load('routes/conversations/messages/create', { './sendMessage.js': send }).default;
  const byId = load('routes/conversations/messages/byId', { ...deps, '../../../attachments/editPolicy.js': editPolicy }).default;
  const typing = load('routes/conversations/messages/typing', { ...deps, '../../../db.js': db, '../../../utils/conversationInteraction.js': interaction }).default;
  const read = load('routes/conversations/messages/read', { './shared.js': shared }).default;
  const bucket = load('middleware/rateLimits/tokenBucketLimiter', {
    '../../valkey.js': esm(redis), './algorithms.js': algorithms,
    '../../utils/securityUtils.js': { getClientIP: () => '127.0.0.1', IPSecurity: { async logIPActivity() {} } },
    '../../utils/deviceFingerprint.js': { DeviceFingerprint: { ensureFingerprint() { throw new Error('Authenticated limiter must use user scope'); } } },
  });
  const spam = load('middleware/rateLimits/dmSpamGuard', { '../../valkey.js': esm(redis) });
  const router = load('routes/conversations/messages', {
    '../../middleware/rate_limit.js': { dmSpamGuard: spam.dmSpamGuard,
      messagesFetchLimiter: bucket.createTokenBucketLimiter(RATE_LIMIT_POLICIES.messagesFetch),
      messagesSendLimiter: bucket.createTokenBucketLimiter(RATE_LIMIT_POLICIES.messagesSend) },
    './messages/create.js': esm(create), './messages/history.js': esm(history), './messages/byId.js': esm(byId),
    './messages/typing.js': esm(typing), './messages/read.js': esm(read),
  }).default;
  const secret = randomBytes(32).toString('hex');
  const tokens = load('auth/services/tokenService', { jsonwebtoken: esm(jwt), uuid: { v4: randomUUID },
    '../config/authSecrets.js': { getAccessSecret: () => secret, getRefreshSecret: () => secret } });
  const sessions = load('auth/services/sessionService', { '../../db.js': db, '../../valkey.js': esm(redis) });
  const auth = load('auth/middleware/authenticateUser', { '../../db.js': db, '../services/sessionService.js': sessions,
    '../services/tokenService.js': tokens, './requestAccount.js': account });
  const csrfKey = randomBytes(32);
  const csrf = load('middleware/encryptedCSRF', { '../utils/authSecrets.js': { getCsrfEncryptionKey: () => csrfKey } });
  const csrfToken = csrf.generateEncryptedCSRFToken();
  const credentials = new Map();
  for (const id of [user, peer, stranger]) {
    const sid = randomUUID(), device = randomUUID();
    const access = tokens.signAccessToken({ id, device_id: device, sid });
    await storage.redis.set(`session:${id}:${device}`, JSON.stringify({ userId: id, deviceId: device, sessionId: sid,
      createdAt: Date.now(), lastSeenAt: Date.now(), ip: 'test', userAgent: 'test', deviceName: 'test', deviceType: 'test' }));
    credentials.set(id, { sid, access, device });
  }
  const app = express();
  app.use(express.json(), cookieParser(), csrf.encryptedCSRFProtection);
  app.use('/api/conversations/:conversationId/messages', auth.authenticateUser, router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/conversations/${conversation}/messages`;
  return { counts, rows, sentinel, user, peer, stranger, conversation, child, shared, credentials,
    async request(path = '?limit=20', { as = user, method = 'GET', body, headers = {} } = {}) {
      const credential = credentials.get(as);
      return fetch(base + path, { method, headers: { 'content-type': 'application/json',
        ...(credential ? { cookie: `accessToken=${credential.access}; _csrf=${encodeURIComponent(csrfToken.encryptedToken)}`, 'x-csrf-token': csrfToken.plainToken } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
    },
    hold() { let release; holdHistory = new Promise(resolve => { release = resolve; }); return () => { release(); holdHistory = null; }; },
  };
}

test('history request operation counts: real auth, PostgreSQL, Valkey, router and delivery', async t => {
  for (const images of [0, 20]) await t.test(`${images} finalized images`, async t => {
    const f = await fixture(t, { images });
    const response = await f.request(); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.messages.length, 20);
    assert.deepEqual(result.messages[0].reactions, { like: { count: 2, me: true } });
    if (images) for (const message of result.messages) {
      const attachment = JSON.parse(message.attachments[0]);
      assert.equal(attachment.inline, true); assert.match(attachment.url, /X-Amz-Signature=/);
      assert.match(attachment.display_url, /^https:\/\/vmd\.invalid\//);
    }
    const actual = { postgres: f.counts.postgres.length, scylla: f.counts.scylla.length,
      reactions: f.counts.scylla.filter(c => /FROM (reaction_counts|user_reactions)/.test(c.sql)).length,
      valkey: f.counts.valkey.length, minio: f.counts.minio };
    assert.deepEqual(actual, { postgres: images ? 3 : 2, scylla: 3, reactions: 2,
      valkey: process.env.HISTORY_BASELINE === '1' ? 15 : 2, minio: 0 });
    console.log(JSON.stringify({ images, baseline: process.env.HISTORY_BASELINE === '1', ...actual }));
    assert.equal(await storage.redis.hget(`rl:messages:fetch:user:${f.user}`, 'tokens'), '119');
    assert.equal(await storage.redis.zcard(`spam:msgs:${f.user}`), process.env.HISTORY_BASELINE === '1' ? 1 : 0);
  });
});

test('group history resolves the storage channel once, without repeating membership', async t => {
  const f = await fixture(t, { type: 'group' });
  assert.equal((await f.request()).status, 200);
  assert.equal(f.counts.postgres.length, 3);
  assert.equal(f.counts.postgres.filter(sql => sql.includes('SELECT role')).length, 1);
  assert.equal(String(f.counts.scylla[0].args[0]), f.child);
  await storage.pool.query("UPDATE conversation_members SET role='viewer' WHERE conversation_id=$1 AND user_id=$2", [f.conversation, f.user]);
  const denied = await f.request('', { method: 'POST', body: { content: 'not allowed' } });
  assert.equal(denied.status, 403); assert.match((await denied.json()).error, /Viewers/);
  assert.equal(f.counts.scylla.some(c => /INSERT/.test(c.sql)), false);
});

test('GET and HEAD retain read limits and cannot bypass auth, account isolation or membership', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('', { as: null })).status, 401);
  assert.equal((await f.request('', { headers: { 'x-void-account-id': f.peer } })).status, 409);
  assert.equal(f.counts.postgres.length, 0);
  assert.equal((await f.request('', { as: f.stranger })).status, 403);
  assert.equal(f.sentinel.getSnapshot().started, 0);
  assert.equal(f.counts.scylla.length, 0);
  for (const path of ['', `/${f.rows[0].message_id}`, `/${f.rows[0].message_id}/context`]) {
    await storage.redis.hset(`rl:messages:fetch:user:${f.user}`, 'blockedUntil', Date.now() + 60_000);
    for (const method of ['GET', 'HEAD']) assert.equal((await f.request(path, { method })).status, 429);
  }
  assert.equal(f.counts.scylla.length, 0);
  assert.equal(await storage.redis.exists(`rl:messages:send:user:${f.user}`), 0);
  assert.equal(await storage.redis.zcard(`spam:msgs:${f.user}`), 0);
  await storage.redis.del(`rl:messages:fetch:user:${f.user}`);
  await storage.redis.hset(`rl:messages:fetch:user:${f.user}`, 'tokens', 0, 'updatedAt', Date.now() + 10_000);
  const exhausted = await f.request();
  assert.equal(exhausted.status, 429); assert.equal(exhausted.headers.get('x-ratelimit-limit'), '120');
  const { sid } = f.credentials.get(f.user);
  await storage.redis.set(`auth:revoked-session:${sid}`, '1');
  assert.equal((await f.request()).status, 401);
});

test('reads do not consume send/fanout budgets; POST retains send limits, spam, CSRF and DM rules', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 17; i++) assert.equal((await f.request()).status, 200);
  assert.equal(await storage.redis.exists(`spam:block:${f.user}`), 0);
  assert.equal(await storage.redis.zcard(`spam:msgs:${f.user}`), 0);
  assert.equal(await storage.redis.zcard(`spam:fanout:${f.user}`), 0);
  const beforeSend = f.counts.valkey.length;
  const response = await f.request('', { method: 'POST', body: { content: 'works after scrolling' } });
  assert.equal(response.status, 201);
  assert.equal(f.counts.valkey.length - beforeSend, 14, 'successful send still runs session, send limiter and all spam commands');
  assert.equal((await response.json()).message.content, 'works after scrolling');
  assert.equal(await storage.redis.zcard(`spam:msgs:${f.user}`), 1);
  assert.equal(await storage.redis.zscore(`spam:fanout:${f.user}`, f.conversation) !== null, true);
  await storage.redis.hset(`rl:messages:send:user:${f.user}`, 'blockedUntil', Date.now() + 60_000);
  assert.equal((await f.request('', { method: 'POST', body: { content: 'blocked' } })).status, 429);
  assert.equal((await f.request()).status, 200, 'a send block does not deny reads');
  await storage.redis.del(`rl:messages:send:user:${f.user}`);
  await storage.redis.set(`spam:block:${f.user}`, JSON.stringify({ blockedUntil: Date.now() + 60_000, reason: 'rate' }));
  assert.equal((await f.request('', { method: 'POST', body: { content: 'blocked' } })).status, 429);
  await storage.redis.del(`spam:block:${f.user}`);
  assert.equal((await f.request('', { method: 'POST', body: { content: 'csrf' }, headers: { 'x-csrf-token': '' } })).status, 403);
  await storage.pool.query('DELETE FROM friendships WHERE requester_id=$1', [f.user]);
  const forbidden = await f.request('', { method: 'POST', body: { content: 'no friendship' } });
  assert.equal(forbidden.status, 403); assert.match((await forbidden.json()).error, /friends/);
});

test('send flood and fanout still block, and non-send writes retain their existing guards', async t => {
  const f = await fixture(t);
  const now = Date.now();
  await storage.redis.zadd(`spam:msgs:${f.user}`, ...Array.from({ length: 15 }, (_, i) => [now, `message-${i}`]).flat());
  const rate = await f.request('', { method: 'POST', body: { content: 'rate' } });
  assert.equal((await rate.json()).code, 'DM_SPAM_RATE_LIMIT');
  await storage.redis.del(`spam:msgs:${f.user}`, `spam:block:${f.user}`);
  await storage.redis.zadd(`spam:fanout:${f.user}`, ...Array.from({ length: 10 }, (_, i) => [now, `conversation-${i}`]).flat());
  const fanout = await f.request('', { method: 'POST', body: { content: 'fanout' } });
  assert.equal((await fanout.json()).code, 'DM_SPAM_FANOUT_LIMIT');
  for (const [method, path] of [['POST', '/typing'], ['PUT', '/read'], ['PUT', `/${f.rows[0].message_id}`], ['DELETE', `/${f.rows[0].message_id}`]]) {
    const blocked = await f.request(path, { method, body: {} });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).code, 'DM_SPAM_FANOUT_LIMIT');
  }
});

test('authorized concurrent histories join only Scylla work; reactions remain user-specific and results are not cached', async t => {
  const f = await fixture(t), release = f.hold();
  t.after(release);
  const first = f.request(), second = f.request('?limit=20', { as: f.peer });
  await until(() => f.sentinel.getSnapshot().joined === 1);
  assert.equal((await f.request('', { as: f.stranger })).status, 403);
  assert.equal(f.sentinel.getSnapshot().joined, 1);
  release();
  const [a, b] = await Promise.all([first.then(r => r.json()), second.then(r => r.json())]);
  assert.equal(a.messages[0].reactions.like.me, true);
  assert.equal(b.messages[0].reactions.like.me, false);
  assert.equal(f.counts.scylla.filter(c => /FROM messages/.test(c.sql)).length, 1);
  assert.equal(f.counts.scylla.filter(c => /FROM (reaction_counts|user_reactions)/.test(c.sql)).length, 4);
  assert.equal(f.sentinel.getSnapshot().active, 0);
  await f.request();
  assert.equal(f.sentinel.getSnapshot().started, 2);
});

test('history flight key separates direction, cursor, storage conversation and chunk size', async t => {
  const f = await fixture(t), release = f.hold();
  t.after(release);
  const a = String(f.rows[0].message_id), b = String(f.rows[1].message_id);
  const requests = ['?limit=20', '?limit=26', `?after=${a}&limit=20`, `?before=${a}&limit=20`, `?before=${b}&limit=20`]
    .map(path => f.request(path));
  await until(() => f.sentinel.getSnapshot().started === requests.length);
  release();
  for (const response of await Promise.all(requests)) assert.equal(response.status, 200);
  assert.equal(f.sentinel.getSnapshot().joined, 0);
  assert.notEqual(createSentinelKey('scylla.messages.history', f.conversation, 'latest', null, 50),
    createSentinelKey('scylla.messages.history', f.child, 'latest', null, 50));
});

test('reaction reads use two partition-batched queries per 50 messages, not one query per row', async t => {
  const f = await fixture(t);
  for (const [size, expected] of [[0, 0], [20, 2], [50, 2], [51, 4], [100, 4]]) {
    const start = f.counts.scylla.length;
    const ids = Array.from({ length: size }, (_, i) => String(f.rows[i % f.rows.length].message_id));
    await f.shared.batchFetchReactions(f.conversation, ids, f.user);
    assert.equal(f.counts.scylla.length - start, expected);
  }
});
