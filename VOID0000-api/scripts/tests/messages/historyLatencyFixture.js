import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import cassandra from 'cassandra-driver';
import { load } from '../media/fixtures.js';
import { historyMetrics } from '../../../server/health/historyMetrics.js';
import { createSentinelKey } from '../../../server/sentinel/index.js';
import * as core from '../../../server/utils/attachmentDeliveryCore.js';
import * as policy from '../../../server/utils/attachmentContentPolicy.js';
import { createAttachmentBlobObjectKey } from '../../../server/attachments/lifecycleCore.js';
import * as account from '../../../server/auth/middleware/requestAccount.js';
import { RATE_LIMIT_POLICIES } from '../../../server/middleware/rateLimits/policies.js';
import * as algorithms from '../../../server/middleware/rateLimits/algorithms.js';
import { createReactionState } from '../../../server/reactions/state.js';
import { readFileSync } from 'node:fs';

const esm = value => ({ __esModule: true, default: value });

// Real route, authentication, limits and datastore clients. Only unused write routes are omitted.
export async function historyLatencyFixture(t, storage, scylla, sentinel, options = {}) {
  const { images = 0, reactions = false, group = false, size = 20 } = options;
  const schema = readFileSync(new URL('../../../db/scylla-migrations/0001_atomic_reactions.cql', import.meta.url), 'utf8').replaceAll('{{KEYSPACE}}.', '');
  for (const sql of schema.split(';').map(s => s.trim()).filter(Boolean)) await scylla.execute(sql);
  await scylla.execute("INSERT INTO reaction_schema(version,ready) VALUES('atomic_v1',true)");
  const reactionState = createReactionState(scylla);
  const user = randomUUID(), conversation = randomUUID(), channel = group ? randomUUID() : conversation;
  const counters = { pgWaitMs: [], pgQueryMs: [], scyllaMs: [], valkeyMs: [], minioStats: 0, pgWaitingMax: 0, scyllaInFlightMax: 0 };
  const queries = new Map();
  let activeScylla = 0;
  const db = { pool: { async query(sql, args) {
    queries.set(sql, args);
    const started = performance.now();
    const acquiring = storage.pool.connect();
    counters.pgWaitingMax = Math.max(counters.pgWaitingMax, storage.pool.waitingCount);
    const client = await acquiring;
    counters.pgWaitMs.push(performance.now() - started);
    const querying = performance.now();
    try { return await client.query(sql, args); }
    finally { counters.pgQueryMs.push(performance.now() - querying); client.release(); }
  } } };
  const measuredScylla = { async execute(...args) {
    const start = performance.now();
    counters.scyllaInFlightMax = Math.max(counters.scyllaInFlightMax, ++activeScylla);
    try { return await scylla.execute(...args); }
    finally { activeScylla--; counters.scyllaMs.push(performance.now() - start); }
  } };
  const redis = new Proxy(storage.redis, { get(target, key) {
    if (typeof target[key] !== 'function') return target[key];
    return async (...args) => {
      const start = performance.now();
      try { return await target[key](...args); }
      finally { counters.valkeyMs.push(performance.now() - start); }
    };
  } });
  await storage.pool.query('INSERT INTO users(id,username,email,password_hash) VALUES($1,$2,$3,$4)', [user, user, `${user}@test.invalid`, 'unused']);
  await storage.pool.query('INSERT INTO conversations(id,type,owner_id) VALUES($1,$2,$3)', [conversation, group ? 'group' : 'dm', user]);
  if (group) await storage.pool.query("INSERT INTO conversations(id,type,parent_conversation_id,name) VALUES($1,'channel',$2,'general')", [channel, conversation]);
  await storage.pool.query("INSERT INTO conversation_members(conversation_id,user_id,role) VALUES($1,$2,'member')", [conversation, user]);
  const ids = [];
  for (let i = 0; i < size; i++) {
    const attachments = [];
    if (i < images) {
      const hash = createHash('sha256').update(`${conversation}:${i}`).digest('hex');
      const key = createAttachmentBlobObjectKey(hash);
      const blob = await storage.pool.query(`INSERT INTO attachment_blobs(content_hash,bucket,object_key,size_bytes,content_type,inline,status)
        VALUES($1,'attachments',$2,100,'image/jpeg',true,'ready') RETURNING id`, [hash, key]);
      const attachment = await storage.pool.query(`INSERT INTO attachment_objects(conversation_id,uploader_id,blob_id,filename,bucket,object_key)
        VALUES($1,$2,$3,'image.jpg','attachments',$4) RETURNING id`, [conversation, user, blob.rows[0].id, key]);
      attachments.push(JSON.stringify({ url: `/api/conversations/${conversation}/attachments/${attachment.rows[0].id}`, mime: 'image/jpeg', width: 1200, height: 800, name: 'image.jpg' }));
    }
    const id = cassandra.types.TimeUuid.fromDate(new Date(Date.now() - (size - i) * 1000)); ids.push(id);
    const conv = cassandra.types.Uuid.fromString(channel), sender = cassandra.types.Uuid.fromString(user);
    await scylla.execute(`INSERT INTO messages(conversation_id,message_id,sender_id,content,message_type,attachments,created_at,is_deleted)
      VALUES(?,?,?,?,'text',?,?,false)`, [conv, id, sender, `Synthetic history message ${i}`, attachments, new Date()], { prepare: true });
    if (reactions) for (const [index, emoji] of ['like', 'heart', 'laugh', 'eyes', 'party', 'wave'].entries()) {
      for (let member = 0; member < 3 + index; member++) await reactionState.set(String(conv), String(id), member === 0 && index % 2 === 0 ? user : randomUUID(), emoji, true);
    }
  }
  const shared = load('routes/conversations/messages/shared', {
    '../../../db.js': db, '../../../scylla.js': { ...esm(measuredScylla), cassandra },
    '../../../utils/conversationIdentity.js': load('utils/conversationIdentity', { '../db.js': db }),
    '../../../utils/messageConversation.js': load('utils/messageConversation', { '../db.js': db }),
  });
  const capability = load('vmd/capability', {}, { VMD_SIGNING_SECRET: randomBytes(32).toString('hex'), VMD_PUBLIC_URL: 'https://vmd.invalid' });
  const delivery = load('utils/attachmentDelivery', {
    '../db.js': db, '../minio.js': { ATTACH_BUCKET: 'attachments', cdnMinioClient: storage.objects,
      minioClient: { statObject(...args) { counters.minioStats++; return storage.objects.statObject(...args); } } },
    '../vmd/capability.js': capability, './attachmentDeliveryCore.js': core, './attachmentContentPolicy.js': policy,
  });
  const history = load('routes/conversations/messages/history', {
    './shared.js': shared, '../../../utils/attachmentDelivery.js': delivery,
    '../../../sentinel/index.js': { ...esm(sentinel), createSentinelKey },
  }).default;
  const bucket = load('middleware/rateLimits/tokenBucketLimiter', {
    '../../valkey.js': esm(redis), './algorithms.js': algorithms,
    '../../utils/securityUtils.js': { getClientIP: () => '127.0.0.1', IPSecurity: { async logIPActivity() {} } },
    '../../utils/deviceFingerprint.js': { DeviceFingerprint: { ensureFingerprint() { throw new Error('Expected authenticated limiter'); } } },
  });
  const unused = esm(express.Router());
  const router = load('routes/conversations/messages', {
    '../../middleware/rate_limit.js': {
      messagesFetchLimiter: bucket.createTokenBucketLimiter(RATE_LIMIT_POLICIES.messagesFetch),
      messagesSendLimiter() { throw new Error('History entered send limiter'); }, dmSpamGuard() { throw new Error('History entered spam guard'); },
    }, './messages/history.js': esm(history), './messages/create.js': unused, './messages/typing.js': unused,
    './messages/read.js': unused, './messages/byId.js': unused,
  }).default;
  const secret = randomBytes(32).toString('hex');
  const tokens = load('auth/services/tokenService', { jsonwebtoken: esm(jwt), uuid: { v4: randomUUID },
    '../config/authSecrets.js': { getAccessSecret: () => secret, getRefreshSecret: () => secret } });
  const sessions = load('auth/services/sessionService', { '../../db.js': db, '../../valkey.js': esm(redis) });
  const auth = load('auth/middleware/authenticateUser', { '../../db.js': db, '../services/sessionService.js': sessions,
    '../services/tokenService.js': tokens, './requestAccount.js': account });
  const sid = randomUUID(), device = randomUUID();
  const access = tokens.signAccessToken({ id: user, device_id: device, sid });
  await storage.redis.set(`session:${user}:${device}`, JSON.stringify({ userId: user, deviceId: device, sessionId: sid,
    createdAt: Date.now(), lastSeenAt: Date.now(), ip: 'test', userAgent: 'test', deviceName: 'test', deviceType: 'test' }));
  const csrfKey = randomBytes(32);
  const csrf = load('middleware/encryptedCSRF', { '../utils/authSecrets.js': { getCsrfEncryptionKey: () => csrfKey } });
  const app = express();
  app.use(cookieParser(), csrf.encryptedCSRFProtection);
  app.use('/api/conversations/:conversationId/messages', historyMetrics.request, historyMetrics.middleware('auth', auth.authenticateUser), router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/conversations/${conversation}/messages`;
  return {
    counters, shared, ids, channel, user,
    client: { base, cookie: `accessToken=${access}` },
    async explain() {
      const results = [];
      for (const [sql, args] of queries) {
        const result = await storage.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, args);
        const plan = result.rows[0]['QUERY PLAN'][0];
        const name = sql.includes('attachment_objects') ? 'attachments' : sql.includes('conversation_members') ? 'membership'
          : sql.includes('parent_conversation_id =') ? 'storage_resolution' : 'conversation';
        // Do not serialize plans: Index Cond / Filter can contain identifiers.
        results.push({ name, planningMs: plan['Planning Time'], executionMs: plan['Execution Time'], rows: plan.Plan['Actual Rows'] });
      }
      return results;
    },
    async reset() {
      // Only this synthetic user's isolated limiter; production policy is never altered.
      await storage.redis.del(`rl:messages:fetch:user:${user}`);
      for (const key of Object.keys(counters)) counters[key] = Array.isArray(counters[key]) ? [] : 0;
    },
    request(limit = 20) { return fetch(`${base}?limit=${limit}`, { headers: { cookie: `accessToken=${access}` }, signal: AbortSignal.timeout(10_000) }); },
  };
}
