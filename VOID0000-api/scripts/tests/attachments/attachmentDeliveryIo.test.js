import assert from 'node:assert/strict';
import test from 'node:test';
import * as crypto from 'node:crypto';
import { Client } from 'minio';
import sharp from 'sharp';
import express from 'express';
import cassandra from 'cassandra-driver';
import * as core from '../../../server/utils/attachmentDeliveryCore.js';
import * as policy from '../../../server/utils/attachmentContentPolicy.js';
import * as lifecycle from '../../../server/attachments/lifecycleCore.js';
import { sanitizeChatAttachmentImage } from '../../../server/utils/chatImageSanitizer.js';
import { createAttachmentUploadProcessor } from '../../../server/attachments/uploadProcessor.js';
import * as consistency from '../../../server/attachments/messageConsistency.js';
import * as editPolicy from '../../../server/attachments/editPolicy.js';
import * as eventIdentity from '../../../server/utils/eventIdentity.js';
import { load, services } from '../media/fixtures.js';

const conversation = '00000000-0000-4000-8000-000000000001';
const otherConversation = '00000000-0000-4000-8000-000000000002';
const id = i => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
function blob(i, extra = {}) {
  const hash = crypto.createHash('sha256').update(String(i)).digest('hex');
  return { id: id(i), conversation_id: conversation, bucket: 'attachments',
    object_key: lifecycle.createAttachmentBlobObjectKey(hash), content_hash: hash,
    content_type: 'image/jpeg', inline: true, blob_status: 'ready', filename: `${i}.jpg`, ...extra };
}
function descriptor(row, extra = {}) {
  return JSON.stringify({ id: row.id, url: `/api/conversations/${conversation}/attachments/${row.id}`,
    mime: row.content_type || 'image/jpeg', name: row.filename, width: 640, height: 480, ...extra });
}
function fixture(rows, overrides = {}) {
  const counts = { queries: 0, stats: 0, presigns: 0, vmd: 0, hmac: 0, signingNetwork: 0 };
  const client = new Client({ endPoint: 'cdn.invalid', accessKey: 'test', secretKey: 'test-only',
    region: 'us-east-1', transport: { request() { counts.signingNetwork++; throw new Error('Signing must stay local'); } } });
  const capability = load('vmd/capability', { crypto: { ...crypto,
    createHmac(...args) { counts.hmac++; return crypto.createHmac(...args); },
  } }, { VMD_SIGNING_SECRET: 'test-only-'.repeat(8), VMD_PUBLIC_URL: 'https://vmd.invalid' });
  let now = Date.now();
  const delivery = load('utils/attachmentDelivery', {
    '../db.js': { pool: { async query(sql, params) {
      counts.queries++;
      assert.match(sql, /attachment\.conversation_id = \$1/);
      assert.match(sql, /blob\.bucket = \$2/);
      assert.match(sql, /poster\.bucket = \$2/);
      assert.match(sql, /blob\.content_hash, blob\.content_type, blob\.inline/);
      if (overrides.query) return overrides.query(sql, params);
      return { rows: rows.filter(r => r.conversation_id === params[0] && r.bucket === params[1] && params[2].includes(r.id)) };
    } } },
    '../minio.js': { ATTACH_BUCKET: 'attachments', minioClient: { async statObject(bucket, key) {
      counts.stats++;
      if (overrides.stat) return overrides.stat(bucket, key);
      return { metaData: { 'content-type': 'image/jpeg', 'void-sanitized-image': '1' } };
    } }, cdnMinioClient: { async presignedGetObject(...args) {
      counts.presigns++;
      return (overrides.client || client).presignedGetObject(...args);
    } } },
    '../vmd/capability.js': { createVmdResponsiveImageDelivery(attachmentId) {
      counts.vmd++;
      return capability.createVmdResponsiveImageDelivery(attachmentId, { now });
    } },
    './attachmentDeliveryCore.js': core,
    './attachmentContentPolicy.js': policy,
  });
  return { ...delivery, counts, advance: ms => { now += ms; } };
}

for (const count of [0, 1, 5, 20]) {
  test(`20-message history with ${count} finalized images: one batch, zero storage metadata I/O`, async () => {
    const rows = Array.from({ length: count }, (_, i) => blob(i + 1));
    const f = fixture(rows);
    const messages = Array.from({ length: 20 }, (_, i) => ({ message_id: String(i), attachments: rows[i] ? [descriptor(rows[i])] : [] }));
    const result = await f.attachSignedAttachmentUrls(messages, conversation);
    // One domain-separated key derivation plus three variant signatures per image.
    assert.deepEqual(f.counts, { queries: count ? 1 : 0, stats: 0, presigns: count, vmd: count, hmac: count * 4, signingNetwork: 0 });
    assert.deepEqual(result.map(m => m.message_id), messages.map(m => m.message_id));
    for (const m of result.filter(m => m.attachments.length)) {
      const a = JSON.parse(m.attachments[0]);
      assert.equal(a.inline, true);
      assert.equal(new URL(a.url).searchParams.get('response-content-type'), 'image/jpeg');
      assert.deepEqual(Object.keys(a.display_variants), ['small', 'medium', 'large']);
      assert.match(a.fallback_url, /\/api\/conversations\//);
    }
  });
}

test('multiple images, duplicate references and repeated/expired delivery keep bounded operation counts', async () => {
  const rows = [blob(1), blob(2), blob(3)];
  const f = fixture(rows);
  const input = [{ attachments: [descriptor(rows[2]), descriptor(rows[0]), descriptor(rows[1]), descriptor(rows[0])] }];
  const first = await f.attachSignedAttachmentUrls(input, conversation);
  const repeated = await f.attachSignedAttachmentUrls(first, conversation);
  assert.deepEqual(first[0].attachments.map(a => JSON.parse(a).id), [id(3), id(1), id(2), id(1)]);
  assert.equal(JSON.parse(first[0].attachments[0]).display_url, JSON.parse(repeated[0].attachments[0]).display_url);
  f.advance(3600_000);
  const expired = await f.attachSignedAttachmentUrls(first, conversation);
  assert.notEqual(JSON.parse(first[0].attachments[0]).display_url, JSON.parse(expired[0].attachments[0]).display_url);
  assert.deepEqual(f.counts, { queries: 3, stats: 0, presigns: 9, vmd: 9, hmac: 36, signingNetwork: 0 });
});

test('non-image files stay attachment/octet-stream, never VMD even with an image-looking descriptor', async () => {
  const row = blob(1, { inline: false, content_type: 'application/octet-stream', filename: 'file.html' });
  const f = fixture([row]);
  const [message] = await f.attachSignedAttachmentUrls([{ attachments: [descriptor(row, { mime: 'image/jpeg' })] }], conversation);
  const a = JSON.parse(message.attachments[0]);
  assert.equal(a.inline, false);
  assert.equal(a.display_url, undefined);
  assert.equal(new URL(a.url).searchParams.get('response-content-disposition'), 'attachment; filename="file.html"');
  assert.equal(new URL(a.url).searchParams.get('response-content-type'), 'application/octet-stream');
  assert.equal(f.counts.stats, 0);
  assert.equal(f.counts.vmd, 0);
});

test('trusted video and poster use persisted policy and retain original Range-capable delivery URLs', async () => {
  const poster = blob(2, { content_type: 'image/webp' });
  const video = blob(1, { content_type: 'video/mp4', filename: 'movie.mp4',
    video_metadata: { mime: 'video/mp4', width: 1920, height: 1080, duration_ms: 2000, poster: { width: 480, height: 270 } },
    poster_key: poster.object_key, poster_content_hash: poster.content_hash, poster_content_type: poster.content_type,
    poster_inline: true, poster_blob_status: 'ready' });
  const f = fixture([video]);
  const [message] = await f.attachSignedAttachmentUrls([{ attachments: [descriptor(video)] }], conversation);
  const a = JSON.parse(message.attachments[0]);
  assert.equal(a.video_trusted, true);
  assert.equal(a.width, 1920);
  assert.equal(a.poster.width, 480);
  assert.equal(new URL(a.url).searchParams.get('response-content-type'), 'video/mp4');
  assert.equal(new URL(a.poster.url).searchParams.get('response-content-type'), 'image/webp');
  assert.deepEqual(f.counts, { queries: 1, stats: 0, presigns: 2, vmd: 0, hmac: 0, signingNetwork: 0 });
});

test('legacy and incomplete policies still require exact storage markers', async () => {
  for (const patch of [
    { content_hash: null }, { inline: null }, { inline: undefined }, { inline: 'true' }, { inline: 0 }, { inline: '' }, { content_type: null },
    { content_type: 'text/html' }, { blob_status: 'deleting' }, { object_key: 'legacy.jpg' },
    { content_hash: 'f'.repeat(64) },
  ]) {
    const row = blob(1, patch);
    const f = fixture([row], { stat: async () => ({ metaData: { 'content-type': 'image/jpeg', 'void-sanitized-image': 'true' } }) });
    const [message] = await f.attachSignedAttachmentUrls([{ attachments: [descriptor(row)] }], conversation);
    const a = JSON.parse(message.attachments[0]);
    assert.equal(f.counts.stats, 1);
    assert.equal(a.inline, false);
    assert.equal(a.display_url, undefined);
  }
  const row = blob(1, { content_hash: null, inline: null, content_type: null });
  const f = fixture([row]);
  const [message] = await f.attachSignedAttachmentUrls([{ attachments: [descriptor(row)] }], conversation);
  assert.equal(JSON.parse(message.attachments[0]).inline, true);
  assert.equal(f.counts.stats, 1);
  assert.equal(f.counts.vmd, 1);
});

test('foreign/missing IDs are not signed; lookup failure preserves protected-URL fallback', async () => {
  const row = blob(1, { conversation_id: otherConversation });
  const input = [{ attachments: [descriptor(row)] }];
  const f = fixture([row]);
  const [message] = await f.attachSignedAttachmentUrls(input, conversation);
  assert.equal(JSON.parse(message.attachments[0]).url, JSON.parse(input[0].attachments[0]).url);
  assert.equal(f.counts.presigns, 0);
  assert.equal(f.counts.vmd, 0);
  const unavailable = fixture([], { query: async () => { throw new Error('test-only lookup failure'); } });
  const [fallback] = await unavailable.attachSignedAttachmentUrls(input, conversation);
  assert.equal(JSON.parse(fallback.attachments[0]).url, JSON.parse(input[0].attachments[0]).url);
});

test('actual finalized image/file blob rows support signing without stat; legacy rows still stat', { timeout: 60000 }, async t => {
  const f = await services(t);
  const uploader = crypto.randomUUID();
  await f.pool.query(`INSERT INTO users(id,username,email,password_hash) VALUES($1,'delivery-test','delivery@test.invalid','unused')`, [uploader]);
  await f.pool.query(`INSERT INTO conversations(id,type) VALUES($1,'dm')`, [conversation]);
  const stage = lifecycle.createAttachmentLifecycle({ dbPool: f.pool, objectStore: f.objects, bucket: 'attachments', config: lifecycle.resolveAttachmentLifecycleConfig() });
  const upload = createAttachmentUploadProcessor({ sanitizeImage: sanitizeChatAttachmentImage,
    createStoragePolicy: policy.createAttachmentStoragePolicy, createObjectMetadata: policy.createAttachmentBlobMetadata, lifecycle: stage });
  const image = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#127834' } }).jpeg().toBuffer();
  const uploaded = await upload({ userId: uploader, conversation: { id: conversation },
    files: [{ buffer: image, clientMimeType: 'image/jpeg', clientFilename: 'photo.jpg' },
      { buffer: Buffer.from('plain text file'), clientMimeType: 'text/plain', clientFilename: 'note.txt' }],
    buildPrivateUrl: (c, aid) => `/api/conversations/${c.id}/attachments/${aid}` });
  const delivery = fixture([], { query: (...args) => f.pool.query(...args), client: f.objects, stat: (...args) => f.objects.statObject(...args) });
  const [message] = await delivery.attachSignedAttachmentUrls([{ attachments: uploaded.attachments.map(a => JSON.stringify(a)) }], conversation);
  assert.equal(delivery.counts.queries, 1);
  assert.equal(delivery.counts.stats, 0);
  for (const [index, raw] of message.attachments.entries()) {
    const a = JSON.parse(raw), response = await fetch(a.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), index ? 'application/octet-stream' : 'image/jpeg');
    assert.match(response.headers.get('content-disposition'), index ? /^attachment;/ : /^inline;/);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  // Model the existing 0011 historical backfill, which deliberately has no proof.
  await f.pool.query('UPDATE attachment_blobs SET content_hash=NULL,content_type=NULL,inline=NULL');
  const legacy = await delivery.attachSignedAttachmentUrls([{ attachments: uploaded.attachments.map(a => JSON.stringify(a)) }], conversation);
  assert.equal(delivery.counts.stats, 2);
  assert.equal(JSON.parse(legacy[0].attachments[0]).inline, true);
  assert.equal(JSON.parse(legacy[0].attachments[1]).inline, false);
});

test('history, pagination, message-by-ID refresh and send response use the optimized mapper after membership checks', async t => {
  const user = id(90), foreignUser = id(91), row = blob(1), f = fixture([row]);
  const calls = [];
  const stored = Array.from({ length: 21 }, () => ({
    conversation_id: cassandra.types.Uuid.fromString(conversation), message_id: cassandra.types.TimeUuid.now(),
    sender_id: cassandra.types.Uuid.fromString(user), content: 'image', attachments: [descriptor(row)],
    created_at: new Date(), is_deleted: false,
  }));
  const pool = {
    async query(sql, params) {
      if (sql.includes('SELECT role')) return { rows: params[1] === user ? [{ role: 'member' }] : [] };
      if (sql.includes('SELECT user_id')) return { rows: [{ user_id: user }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async connect() { return { query: async sql => { calls.push(sql.trim().split(/\s+/)[0]); }, release() {} }; },
  };
  const scylla = { async execute(sql, params, options) {
    if (sql.includes('FROM reaction_schema')) return { rows: [{ ready: true }] };
    calls.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    if (sql.includes('INSERT INTO messages')) {
      assert.equal(options.consistency, cassandra.types.consistencies.localQuorum);
      return { rows: [] };
    }
    if (!sql.includes('FROM messages')) return { rows: [] };
    if (sql.includes('message_id = ?')) return { rows: stored.filter(m => String(m.message_id) === String(params[1])) };
    const cursor = stored.findIndex(m => String(m.message_id) === String(params[1]));
    return { rows: sql.includes('message_id >') ? stored.slice(cursor + 1) : sql.includes('message_id <') ? stored.slice(0, cursor) : stored };
  } };
  const shared = load('routes/conversations/messages/shared', {
    '../../../db.js': { pool }, '../../../scylla.js': { default: scylla, cassandra, __esModule: true },
    '../../../utils/conversationIdentity.js': { findConversationByIdentifier: async value => value === conversation ? { id: conversation, type: 'dm', public_id: '123' } : null },
    '../../../utils/messageConversation.js': { resolveMessageStorageConversation: async c => c },
  });
  const deps = { './shared.js': shared, '../../../utils/attachmentDelivery.js': f,
    '../../../gateway/client.js': { sendLiveEventToUser() {} }, '../../../utils/debugLog.js': { debugLog() {} } };
  const history = load('routes/conversations/messages/history', { ...deps,
    '../../../sentinel/index.js': { default: { guard: (_key, task) => task() }, __esModule: true, createSentinelKey: (...args) => args.join(':') },
  }).default;
  const byId = load('routes/conversations/messages/byId', { ...deps, '../../../attachments/editPolicy.js': editPolicy }).default;
  const app = express();
  // Production session validation is covered by the auth suite; this fixture
  // exercises real route membership checks and the real delivery implementation.
  app.use((req, _res, next) => { if (req.headers['x-test-user']) req.user = { id: req.headers['x-test-user'] }; next(); });
  app.use('/api/conversations/:conversationId/messages', history, byId);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/conversations/${conversation}/messages`;
  for (const path of ['', `/${stored[0].message_id}`]) {
    assert.equal((await fetch(`${base}${path}`)).status, 401);
    assert.equal((await fetch(`${base}${path}`, { headers: { 'x-test-user': foreignUser } })).status, 403);
  }
  assert.equal(f.counts.queries, 0, 'unauthorized requests must never reach attachment hydration');
  for (const path of ['?limit=20', `?limit=20&before=${stored[20].message_id}`, `?limit=20&after=${stored[0].message_id}`, `/${stored[0].message_id}`]) {
    const response = await fetch(`${base}${path}`, { headers: { 'x-test-user': user } });
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const m of body.messages || [body.message]) assert.equal(JSON.parse(m.attachments[0]).inline, true);
  }
  const send = load('routes/conversations/messages/sendMessage', { ...deps,
    './sendOperation.js': load('routes/conversations/messages/sendOperation', {}),
    '../../../attachments/lifecycle.js': { ...lifecycle, attachmentLifecycle: {
      reserveForMessage: async args => ({ ...args, state: 'reserved_new' }),
      acknowledgeScyllaWrite: async () => { calls.push('acknowledge'); },
      commitReservation: async () => { calls.push('commitReservation'); },
    } },
    '../../../attachments/messageConsistency.js': consistency,
    '../../../utils/conversationInteraction.js': { canInteractInConversation: async () => true },
    '../../../utils/groupPermissions.js': {}, '../../../utils/eventIdentity.js': eventIdentity,
    '../../../notifications/webPush.js': { dispatchMessagePushNotifications() {} },
    '../../../valkey.js': { default: {}, __esModule: true },
  });
  const sent = await send.sendConversationMessage({ userId: user, conversationIdentifier: conversation,
    body: { content: 'send response', attachments: [descriptor(row)] } });
  assert.equal(JSON.parse(sent.message.attachments[0]).inline, true);
  assert.ok(calls.indexOf('INSERT INTO messages') < calls.indexOf('acknowledge'));
  assert.ok(calls.indexOf('acknowledge') < calls.indexOf('COMMIT'));
  assert.deepEqual(f.counts, { queries: 5, stats: 0, presigns: 5, vmd: 5, hmac: 20, signingNetwork: 0 });
});
