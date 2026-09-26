import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import cassandra from 'cassandra-driver';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { load, root } from '../media/fixtures.js';
import * as interaction from '../../../server/utils/conversationInteraction.js';
import * as identity from '../../../server/utils/eventIdentity.js';
import * as account from '../../../server/auth/middleware/requestAccount.js';
import * as algorithms from '../../../server/middleware/rateLimits/algorithms.js';
import { RATE_LIMIT_POLICIES } from '../../../server/middleware/rateLimits/policies.js';
import { createReactionState, ReactionError } from '../../../server/reactions/state.js';

const esm = value => ({ __esModule: true, default: value });
export async function reactionScylla(t, { ready = true } = {}) {
  const keyspace = `void_reaction_audit_${randomUUID().replaceAll('-', '')}`;
  const admin = new cassandra.Client({ contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1' });
  await admin.connect(); t.after(() => admin.shutdown());
  const ddl = sql => admin.execute(sql, [], { readTimeout: 60_000 });
  t.after(() => ddl(`DROP KEYSPACE IF EXISTS ${keyspace}`));
  await ddl(`CREATE KEYSPACE ${keyspace} WITH replication = {'class':'NetworkTopologyStrategy','datacenter1':1} AND tablets = {'enabled':false}`);
  for (const sql of readFileSync(join(root, 'db/scylla-migrations/0000_message_storage.cql'), 'utf8').replaceAll('{{KEYSPACE}}', keyspace).split(';').map(s => s.trim()).filter(Boolean)) await ddl(sql);
  for (const sql of readFileSync(join(root, 'db/scylla-migrations/0001_atomic_reactions.cql'), 'utf8').replaceAll('{{KEYSPACE}}', keyspace).split(';').map(s => s.trim()).filter(Boolean)) await ddl(sql);
  const client = new cassandra.Client({ contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1', keyspace });
  await client.connect(); t.after(() => client.shutdown());
  if (ready) await client.execute("INSERT INTO reaction_schema(version,ready) VALUES('atomic_v1',true)");
  return client;
}

export async function reactionAuditFixture(t, storage, scyllaClient, { members = 2, type = 'dm', barrierCount = 0, barrierAt = 'membership', extraDependencies = {} } = {}) {
  const counts = { pg: [], scylla: [], valkey: [], events: [], publishes: [], stages: {} }, faults = {}, outstanding = [];
  const timed = (stage, fn) => async (...args) => {
    const start = performance.now();
    try { return await fn(...args); } finally { (counts.stages[stage] ||= []).push(performance.now() - start); }
  };
  const pool = { query: timed('pg', (sql, args) => { counts.pg.push(sql); return storage.pool.query(sql, args); }) };
  const redis = new Proxy(storage.redis, { get(target, method) { return timed('valkey', (...args) => { counts.valkey.push(method); return target[method](...args); }); } });
  const users = Array.from({ length: members }, randomUUID), conversation = randomUUID(), child = randomUUID();
  await storage.pool.query(`INSERT INTO users(id,username,email,password_hash) SELECT x,x::text,x::text||'@test.invalid','unused' FROM unnest($1::uuid[]) x`, [users]);
  await storage.pool.query('INSERT INTO conversations(id,type,owner_id) VALUES($1,$2,$3)', [conversation, type === 'channel' ? 'group' : type, users[0]]);
  if (type !== 'dm') await storage.pool.query("INSERT INTO conversations(id,type,parent_conversation_id,name) VALUES($1,'channel',$2,'general')", [child, conversation]);
  const logicalId = type === 'channel' ? child : conversation, storageId = type === 'dm' ? conversation : child;
  for (const id of type === 'channel' ? [conversation, child] : [conversation]) await storage.pool.query("INSERT INTO conversation_members(conversation_id,user_id,role) SELECT $1,x,'member' FROM unnest($2::uuid[]) x", [id, users]);
  if (type === 'dm') {
    await storage.pool.query('INSERT INTO dm_pairs(conversation_id,user_a,user_b) VALUES($1,$2,$3)', [conversation, ...users.slice(0, 2).sort()]);
    await storage.pool.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES($1,$2,'accepted')", [users[0], users[1]]);
  }
  const conv = cassandra.types.Uuid.fromString(storageId), message = cassandra.types.TimeUuid.now();
  await scyllaClient.execute('INSERT INTO messages(conversation_id,message_id,sender_id,content,is_deleted,created_at) VALUES(?,?,?,?,false,?)', [conv, message, cassandra.types.Uuid.fromString(users[0]), 'reaction audit', new Date()], { prepare: true });
  let reached = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const execute = timed('scylla', async (sql, args, options) => {
    counts.scylla.push({ sql, options });
    if (faults.table && sql.includes(faults.table) && !sql.startsWith('SELECT')) { faults.table = null; throw new Error('Injected reaction mutation failure'); }
    const result = await scyllaClient.execute(sql, args.map(value => Object.prototype.toString.call(value) === '[object Date]' ? new Date(value.getTime()) : value), options);
    if (sql.startsWith('BEGIN BATCH') && faults.afterBatch) { faults.afterBatch = false; throw new Error('Injected timeout after atomic batch'); }
    const hit = barrierAt === 'membership' ? sql.startsWith('SELECT user_id FROM message_reactions') : sql.startsWith('SELECT emoji, count FROM reaction_counts');
    if (hit && barrierCount && reached < barrierCount) { if (++reached === barrierCount) release(); await barrier; }
    return result;
  });
  const scylla = { execute(...args) { const result = execute(...args); outstanding.push(result.catch(() => {})); return result; } };
  const db = { pool }, gateway = load('gateway/client', { '../valkey.js': esm(redis), './presenceMode.js': {}, './protocol.js': {},
    '../valkey-pubsub.js': { publishToGateway(event, targetUserId, data) {
      const start = performance.now();
      const envelope = JSON.stringify({ event, targetUserId, data, timestamp: Date.now() }); counts.publishes.push({ event, bytes: Buffer.byteLength(envelope), data });
      (counts.stages.serialization ||= []).push(performance.now() - start);
      const publishStart = performance.now();
      outstanding.push(storage.redis.publish('void:test:reactions', envelope).finally(() => { (counts.stages.publish ||= []).push(performance.now() - publishStart); }));
    } },
  });
  const state = createReactionState(scylla);
  await state.ensureReady(); counts.scylla.length = 0; counts.stages.scylla = [];
  const route = load('routes/conversations/reactions', {
    '../../db.js': db, '../../scylla.js': { ...esm(scylla), cassandra },
    '../../utils/conversationInteraction.js': interaction, '../../utils/eventIdentity.js': identity,
    '../../utils/conversationIdentity.js': load('utils/conversationIdentity', { '../db.js': db }),
    '../../utils/messageConversation.js': load('utils/messageConversation', { '../db.js': db }),
    '../../gateway/client.js': { queueReactionEventToUser(user, data) { const start = performance.now(); counts.events.push({ user, data }); gateway.queueReactionEventToUser(user, data); (counts.stages.enqueue ||= []).push(performance.now() - start); } },
    '../../reactions/index.js': { reactionState: state }, '../../reactions/state.js': { ReactionError },
    ...extraDependencies,
  }).default;
  const secret = randomBytes(32).toString('hex');
  const tokens = load('auth/services/tokenService', { jsonwebtoken: esm(jwt), uuid: { v4: randomUUID }, '../config/authSecrets.js': { getAccessSecret: () => secret, getRefreshSecret: () => secret } });
  const sessions = load('auth/services/sessionService', { '../../db.js': db, '../../valkey.js': esm(redis) });
  const auth = load('auth/middleware/authenticateUser', { '../../db.js': db, '../services/sessionService.js': sessions, '../services/tokenService.js': tokens, './requestAccount.js': account });
  const csrf = load('middleware/encryptedCSRF', { '../utils/authSecrets.js': { getCsrfEncryptionKey: () => Buffer.alloc(32, 6) } });
  const csrfToken = csrf.generateEncryptedCSRFToken(), headers = {};
  for (const id of users) {
    const sid = randomUUID(), device = randomUUID();
    await storage.redis.set(`session:${id}:${device}`, JSON.stringify({ userId: id, deviceId: device, sessionId: sid, createdAt: Date.now(), lastSeenAt: Date.now(), ip: 'test', userAgent: 'test', deviceName: 'test', deviceType: 'test' }));
    headers[id] = { 'content-type': 'application/json', cookie: `accessToken=${tokens.signAccessToken({ id, device_id: device, sid })}; _csrf=${encodeURIComponent(csrfToken.encryptedToken)}`, 'x-csrf-token': csrfToken.plainToken };
  }
  const bucket = load('middleware/rateLimits/tokenBucketLimiter', { '../../valkey.js': esm(redis), './algorithms.js': algorithms,
    '../../utils/securityUtils.js': { getClientIP: () => '127.0.0.1', IPSecurity: { async logIPActivity() {} } },
    '../../utils/deviceFingerprint.js': { DeviceFingerprint: { ensureFingerprint() { throw new Error('Expected authenticated limiter'); } } },
  });
  const app = express(); app.use(express.json(), cookieParser(), csrf.encryptedCSRFProtection);
  app.use('/api/conversations/:conversationId/messages/:messageId/reactions', timed('auth', auth.authenticateUser), timed('limiter', bucket.createTokenBucketLimiter(RATE_LIMIT_POLICIES.messageReactionToggle)), route);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { counts, faults, users, logicalId, storageId, message, conv, scylla, headers, state,
    async request(emoji = 'a', { method = 'PUT', user = users[0], headerOverrides = {}, body = { present: method === 'PUT' } } = {}) {
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/conversations/${logicalId}/messages/${message}/reactions/${encodeURIComponent(emoji)}`, { method, headers: { ...headers[user], ...headerOverrides }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      return { status: response.status, body: await response.json(), ms: performance.now() - start };
    },
    async inspectLegacy(emojis = ['a']) {
      await Promise.all(outstanding);
      const memberships = {}, mine = {};
      for (const emoji of emojis) memberships[emoji] = (await scyllaClient.execute('SELECT user_id FROM message_reactions WHERE conversation_id=? AND message_id=? AND emoji=?', [conv, message, emoji], { prepare: true })).rows.map(r => r.user_id.toString()).sort();
      for (const user of users) mine[user] = (await scyllaClient.execute('SELECT emoji FROM user_reactions WHERE conversation_id=? AND user_id=? AND message_id=?', [conv, cassandra.types.Uuid.fromString(user), message], { prepare: true })).rows.map(r => r.emoji).sort();
      const counters = (await scyllaClient.execute('SELECT emoji,count FROM reaction_counts WHERE conversation_id=? AND message_id=?', [conv, message], { prepare: true })).rows.map(r => [r.emoji, r.count.toNumber()]);
      return { memberships, mine, counters: Object.fromEntries(counters) };
    },
    async inspect() {
      await Promise.all(outstanding);
      const rows = (await scyllaClient.execute('SELECT user_id,emojis,counts,revision FROM reaction_state WHERE conversation_id=? AND message_id=?', [conv, message], { prepare: true })).rows;
      const memberships = {}, mine = {};
      for (const row of rows) for (const emoji of row.emojis ?? []) { (memberships[emoji] ||= []).push(String(row.user_id)); (mine[String(row.user_id)] ||= []).push(emoji); }
      return { memberships, mine, counters: rows[0]?.counts || {}, revision: String(rows[0]?.revision || 0) };
    },
    async seed(emojis, user = users[0]) { for (const emoji of emojis) await createReactionState(scyllaClient).set(storageId, String(message), user, emoji, true); },
    async seedLegacy(emojis, user = users[0]) {
      for (const emoji of emojis) {
        await scyllaClient.execute('INSERT INTO message_reactions(conversation_id,message_id,emoji,user_id,created_at) VALUES(?,?,?,?,?)', [conv, message, emoji, cassandra.types.Uuid.fromString(user), new Date()], { prepare: true });
        await scyllaClient.execute('UPDATE reaction_counts SET count=count+1 WHERE conversation_id=? AND message_id=? AND emoji=?', [conv, message, emoji], { prepare: true });
        await scyllaClient.execute('INSERT INTO user_reactions(conversation_id,user_id,message_id,emoji) VALUES(?,?,?,?)', [conv, cassandra.types.Uuid.fromString(user), message, emoji], { prepare: true });
      }
    },
    async drain() { await new Promise(resolve => setTimeout(resolve, 180)); await Promise.all(outstanding); },
  };
}
