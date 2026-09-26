import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import cassandra from 'cassandra-driver';
import { load } from '../media/fixtures.js';
import * as lifecycle from '../../../server/attachments/lifecycleCore.js';
import * as consistency from '../../../server/attachments/messageConsistency.js';
import * as permissions from '../../../server/utils/groupPermissions.js';
import * as interaction from '../../../server/utils/conversationInteraction.js';
import * as identity from '../../../server/utils/eventIdentity.js';
import * as account from '../../../server/auth/middleware/requestAccount.js';
import * as deliveryCore from '../../../server/utils/attachmentDeliveryCore.js';
import * as policy from '../../../server/utils/attachmentContentPolicy.js';
import * as sendOperation from '../../../server/routes/conversations/messages/sendOperation.js';
import { RATE_LIMIT_POLICIES } from '../../../server/middleware/rateLimits/policies.js';
import * as algorithms from '../../../server/middleware/rateLimits/algorithms.js';

const esm = value => ({ __esModule: true, default: value });
export async function sendAuditFixture(t, storage, { type = 'dm', members = 2, images = 0, scyllaClient, missBarrier = 0, operationModule } = {}) {
  const counts = { pg: [], scylla: [], valkey: [], batches: 0, publishes: [], eventIds: [], push: 0, stats: 0, stages: {}, serializationMs: 0, publishEnqueueMs: 0 };
  const faults = {}, rows = new Map(), background = [];
  const timed = (name, fn) => async (...args) => {
    const start = performance.now();
    try { return await fn(...args); } finally { (counts.stages[name] ||= []).push(performance.now() - start); }
  };
  let misses = 0, releaseMiss;
  const barrier = new Promise(resolve => { releaseMiss = resolve; });
  const redis = new Proxy(storage.redis, { get(target, method) {
    if (method === 'pipeline') return () => {
      const pipeline = target.pipeline(); let proxy;
      proxy = new Proxy(pipeline, { get(p, command) {
        if (command === 'exec') return () => { counts.batches++; return p.exec(); };
        return (...args) => { counts.valkey.push(command); p[command](...args); return proxy; };
      } }); return proxy;
    };
    return async (...args) => {
      counts.valkey.push(method);
      if (faults.cache && String(args[0]).startsWith('message:idempotency:')) throw new Error('injected cache unavailable');
      if (faults.cacheSet && method === 'set' && String(args[0]).startsWith('message:idempotency:')) throw new Error('injected cache write failure');
      const result = await target[method](...args);
      if (method === 'get' && String(args[0]).startsWith('message:idempotency:') && !result && missBarrier) {
        if (++misses >= missBarrier) releaseMiss(); await barrier;
      }
      return result;
    };
  } });
  let acceptanceUpdate = false;
  const query = (client, sql, args) => timed('pg_query', async () => {
    counts.pg.push(sql);
    if (sql.includes('UPDATE conversations')) acceptanceUpdate = true;
    if (faults.pg && sql.includes('UPDATE conversation_members')) { faults.pg = false; throw new Error('injected PG failure'); }
    if (faults.recipients && sql.includes('SELECT user_id FROM conversation_members')) { faults.recipients = false; throw new Error('injected recipient failure'); }
    if (faults.ack && sql.includes('SET scylla_write_policy = $6')) { faults.ack = false; throw new Error('injected acknowledgement failure'); }
    if (faults.effects && sql.includes('SET effects_scheduled_at=NOW()')) { faults.effects = false; throw new Error('injected scheduling receipt failure'); }
    if (faults.commit && sql === 'COMMIT' && acceptanceUpdate) {
      const mode = faults.commit; faults.commit = false;
      if (mode === 'applied') await client.query(sql, args);
      throw new Error('injected unknown COMMIT');
    }
    return client.query(sql, args);
  })();
  const pool = { query: (sql, args) => query(storage.pool, sql, args), connect: timed('pg_acquire', async () => {
    const client = await storage.pool.connect();
    return { query: (sql, args) => query(client, sql, args), release: error => client.release(error) };
  }) };
  const user = randomUUID(), peer = randomUUID(), conversation = randomUUID(), child = randomUUID();
  const users = [user, peer, ...Array.from({ length: Math.max(0, members - 2) }, randomUUID)];
  for (const id of users) await storage.pool.query('INSERT INTO users(id,username,email,password_hash) VALUES($1,$2,$3,$4)', [id, id, `${id}@test.invalid`, 'unused']);
  await storage.pool.query('INSERT INTO conversations(id,type,owner_id) VALUES($1,$2,$3)', [conversation, type === 'channel' ? 'group' : type, user]);
  if (type !== 'dm') await storage.pool.query("INSERT INTO conversations(id,type,parent_conversation_id,name) VALUES($1,'channel',$2,'general')", [child, conversation]);
  for (const id of users) await storage.pool.query("INSERT INTO conversation_members(conversation_id,user_id,role) VALUES($1,$2,'member')", [conversation, id]);
  if (type === 'channel') for (const id of users) await storage.pool.query("INSERT INTO conversation_members(conversation_id,user_id,role) VALUES($1,$2,'member')", [child, id]);
  if (type === 'dm') {
    await storage.pool.query('INSERT INTO dm_pairs(conversation_id,user_a,user_b) VALUES($1,$2,$3)', [conversation, ...[user, peer].sort()]);
    await storage.pool.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES($1,$2,'accepted')", [user, peer]);
  }
  const attachments = [];
  for (let i = 0; i < images; i++) {
    const hash = createHash('sha256').update(`${conversation}:${i}`).digest('hex'), key = lifecycle.createAttachmentBlobObjectKey(hash);
    const blob = await storage.pool.query(`INSERT INTO attachment_blobs(content_hash,bucket,object_key,size_bytes,content_type,inline,status)
      VALUES($1,'attachments',$2,100,'image/jpeg',true,'ready') RETURNING id`, [hash, key]);
    const row = await storage.pool.query(`INSERT INTO attachment_objects(conversation_id,uploader_id,blob_id,filename,bucket,object_key,size_bytes,status,staged_at,expires_at)
      VALUES($1,$2,$3,'image.jpg','attachments',$4,100,'staged',NOW(),NOW()+INTERVAL '1 hour') RETURNING id`, [type === 'channel' ? child : conversation, user, blob.rows[0].id, key]);
    attachments.push(JSON.stringify({ url: `/api/conversations/${type === 'channel' ? child : conversation}/attachments/${row.rows[0].id}`, mime: 'image/jpeg', width: 640, height: 480 }));
  }
  const scylla = { execute: timed('scylla', async (sql, args, options) => {
    counts.scylla.push({ sql, options });
    const key = `${args[0]}:${args[1]}`;
    if (sql.startsWith('INSERT')) {
      if (faults.scylla === 'before') { faults.scylla = false; throw new Error('injected Scylla failure'); }
      rows.set(key, { conversation_id: args[0], message_id: args[1], sender_id: args[2], content: args[3], message_type: args[4], reply_to: args[5],
        attachments: args[6], forwarded: args[7], mentions: args[8], link_preview: args[9], created_at: args[10], is_deleted: false, is_edited: false });
    }
    if (sql.startsWith('DELETE')) rows.delete(key);
    const nativeArgs = args.map(value => Object.prototype.toString.call(value) === '[object Date]' ? new Date(value.getTime()) : value);
    const result = scyllaClient ? await scyllaClient.execute(sql, nativeArgs, options)
      : { rows: sql.startsWith('SELECT') ? (rows.has(key) ? [rows.get(key)] : []) : [] };
    if (sql.startsWith('INSERT') && faults.scylla === 'after') { faults.scylla = false; throw new Error('injected Scylla timeout after write'); }
    if (sql.startsWith('SELECT') && faults.read) throw new Error('injected read failure');
    if (sql.startsWith('SELECT') && faults.malformed) return { rows: null };
    return result;
  }) };
  const db = { pool };
  const shared = load('routes/conversations/messages/shared', {
    '../../../db.js': db, '../../../scylla.js': { ...esm(scylla), cassandra },
    '../../../utils/conversationIdentity.js': load('utils/conversationIdentity', { '../db.js': db }),
    '../../../utils/messageConversation.js': load('utils/messageConversation', { '../db.js': db }),
  });
  for (const method of ['resolveConversationContexts', 'verifyMembership', 'normalizeMentionMetadata', 'getConversationMembers']) shared[method] = timed(method, shared[method]);
  const capability = load('vmd/capability', {}, { VMD_SIGNING_SECRET: 'test-only-'.repeat(8), VMD_PUBLIC_URL: 'https://vmd.invalid' });
  const delivery = load('utils/attachmentDelivery', {
    '../db.js': db, '../minio.js': { ATTACH_BUCKET: 'attachments', cdnMinioClient: storage.objects, minioClient: { statObject() { counts.stats++; throw new Error('Unexpected stat'); } } },
    '../vmd/capability.js': capability, './attachmentDeliveryCore.js': deliveryCore, './attachmentContentPolicy.js': policy,
  });
  const attachmentsLifecycle = lifecycle.createAttachmentLifecycle({ dbPool: pool, objectStore: storage.objects, bucket: 'attachments' });
  const wrapDelivery = fn => timed('delivery', async (...args) => {
    if (faults.delivery) { faults.delivery = false; throw new Error('injected delivery failure'); } return fn(...args);
  });
  const dependencies = { './shared.js': shared, '../../../utils/attachmentDelivery.js': { ...delivery,
    attachSignedAttachmentUrls: wrapDelivery(delivery.attachSignedAttachmentUrls),
    createAttachmentDeliveryForQueryable: client => timed('delivery', async (...args) => {
      if (faults.delivery) { faults.delivery = false; throw new Error('injected delivery failure'); }
      return delivery.createAttachmentDeliveryForQueryable(client)(...args);
    }),
  }, '../../../gateway/client.js': { sendLiveEventToUser(id, event, data) {
    const start = performance.now();
    const envelope = JSON.stringify({ event, targetUserId: id, data, timestamp: Date.now() }); counts.publishes.push(envelope.length);
    counts.eventIds.push(data.event_id);
    counts.serializationMs += performance.now() - start;
    const enqueue = performance.now();
    background.push(storage.redis.publish('void:test:gateway', envelope));
    counts.publishEnqueueMs += performance.now() - enqueue;
  } }, '../../../utils/debugLog.js': { debugLog() {} }, '../../../utils/conversationInteraction.js': { canInteractInConversation: timed('dm_permission', interaction.canInteractInConversation) },
    '../../../utils/groupPermissions.js': permissions, '../../../attachments/lifecycle.js': { ...lifecycle, attachmentLifecycle: attachmentsLifecycle },
    '../../../attachments/messageConsistency.js': consistency, '../../../utils/eventIdentity.js': identity,
    '../../../notifications/webPush.js': { dispatchMessagePushNotifications() { counts.push++; } }, '../../../valkey.js': esm(redis),
    './sendOperation.js': operationModule ?? sendOperation };
  const send = load('routes/conversations/messages/sendMessage', dependencies);
  const create = load('routes/conversations/messages/create', { './sendMessage.js': send }).default;
  const bucket = load('middleware/rateLimits/tokenBucketLimiter', { '../../valkey.js': esm(redis), './algorithms.js': algorithms,
    '../../utils/securityUtils.js': { getClientIP: () => '127.0.0.1', IPSecurity: { async logIPActivity() {} } },
    '../../utils/deviceFingerprint.js': { DeviceFingerprint: { ensureFingerprint() { throw new Error('Expected authenticated limiter'); } } },
  });
  const spam = load('middleware/rateLimits/dmSpamGuard', { '../../valkey.js': esm(redis) });
  const secret = randomBytes(32).toString('hex');
  const tokens = load('auth/services/tokenService', { jsonwebtoken: esm(jwt), uuid: { v4: randomUUID },
    '../config/authSecrets.js': { getAccessSecret: () => secret, getRefreshSecret: () => secret } });
  const sessions = load('auth/services/sessionService', { '../../db.js': db, '../../valkey.js': esm(redis) });
  const auth = load('auth/middleware/authenticateUser', { '../../db.js': db, '../services/sessionService.js': sessions,
    '../services/tokenService.js': tokens, './requestAccount.js': account });
  const csrf = load('middleware/encryptedCSRF', { '../utils/authSecrets.js': { getCsrfEncryptionKey: () => Buffer.alloc(32, 7) } });
  const csrfToken = csrf.generateEncryptedCSRFToken(), headers = {};
  for (const id of [user, peer]) {
    const sid = randomUUID(), device = randomUUID();
    await storage.redis.set(`session:${id}:${device}`, JSON.stringify({ userId: id, deviceId: device, sessionId: sid, createdAt: Date.now(), lastSeenAt: Date.now(), ip: 'test', userAgent: 'test', deviceName: 'test', deviceType: 'test' }));
    headers[id] = { 'content-type': 'application/json', cookie: `accessToken=${tokens.signAccessToken({ id, device_id: device, sid })}; _csrf=${encodeURIComponent(csrfToken.encryptedToken)}`,
      'x-csrf-token': csrfToken.plainToken };
  }
  const app = express(); app.use(express.json(), cookieParser(), csrf.encryptedCSRFProtection);
  app.use('/api/conversations/:conversationId/messages', timed('auth', auth.authenticateUser),
    timed('limiter', bucket.createTokenBucketLimiter(RATE_LIMIT_POLICIES.messagesSend)), timed('spam', spam.dmSpamGuard), create);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { counts, faults, rows, user, peer, users, conversation, child, attachments, send, pool, attachmentsLifecycle,
    async resetLimits() { for (const id of [user, peer]) await storage.redis.del(`rl:messages:send:user:${id}`, `spam:msgs:${id}`, `spam:block:${id}`, `spam:fanout:${id}`); },
    async request(body = {}, as = user, conv = type === 'channel' ? child : conversation) {
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/conversations/${conv}/messages`, { method: 'POST', headers: headers[as],
        body: JSON.stringify({ content: 'test send', ...body }), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, body: await response.json(), ms: performance.now() - start };
    },
    drain: () => Promise.all(background),
    async unread() { return (await storage.pool.query('SELECT unread_count FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [conversation, peer])).rows[0].unread_count; },
  };
}
