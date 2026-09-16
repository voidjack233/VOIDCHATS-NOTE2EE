import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { request } from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import * as lifecycleCore from '../../../server/attachments/lifecycleCore.js';
import * as contentPolicy from '../../../server/utils/attachmentContentPolicy.js';
import * as deliveryCore from '../../../server/utils/attachmentDeliveryCore.js';
import * as protocol from '../../../server/media/protocol.js';
import * as transport from '../../../server/media/streamUpload.js';
import * as range from '../../../server/media/range.js';
import * as permissions from '../../../server/utils/groupPermissions.js';
import * as interaction from '../../../server/utils/conversationInteraction.js';
import * as rawUpload from '../../../server/attachments/rawUpload.js';
import * as uploadProcessor from '../../../server/attachments/uploadProcessor.js';
import * as imageErrors from '../../../server/utils/chatImageErrors.js';
import { root, services, load, until } from './fixtures.js';

test('real HTTP quarantine -> Stream -> Go -> MP4/poster -> authorized Range delivery', { timeout: 120000 }, async t => {
  const f = await services(t);
  const user = randomUUID(), outsider = randomUUID(), conversation = randomUUID();
  await f.pool.query(`INSERT INTO users(id,username,email,password_hash) VALUES($1,'media-http','media-http@test.invalid','unused'),($2,'outsider','outside@test.invalid','unused')`, [user, outsider]);
  await f.pool.query(`INSERT INTO conversations(id,type,public_id) VALUES($1,'group',732434999193640960)`, [conversation]);
  await f.pool.query(`INSERT INTO conversation_members(conversation_id,user_id,role) VALUES($1,$2,'member')`, [conversation, user]);
  const lifecycle = lifecycleCore.createAttachmentLifecycle({ dbPool: f.pool, objectStore: f.objects, bucket: 'attachments', config: lifecycleCore.resolveAttachmentLifecycleConfig() });
  const storage = { minioClient: f.objects, cdnMinioClient: f.objects, ATTACH_BUCKET: 'attachments', BUCKET: 'avatars', GROUP_AVATAR_BUCKET: 'group-avatars',
    async ensurePrivateBucket(bucket) { if (!await f.objects.bucketExists(bucket)) await f.objects.makeBucket(bucket); await f.objects.setBucketPolicy(bucket, ''); } };
  const identity = { async findConversationByIdentifier(id) { return (await f.pool.query('SELECT * FROM conversations WHERE id::text=$1 OR public_id::text=$1', [id])).rows[0]; } };
  let publishUnavailable = false;
  const router = load('media/ingestRoutes', { '../db.js': { pool: f.pool }, '../valkey.js': { default: { xadd: (...args) => publishUnavailable ? Promise.reject(new Error('unavailable')) : f.redis.xadd(...args) }, __esModule: true },
    '../minio.js': storage, '../utils/conversationIdentity.js': identity, '../utils/conversationInteraction.js': interaction,
    '../utils/groupPermissions.js': permissions, '../middleware/rate_limit.js': { attachmentUploadLimiter: (_req, _res, next) => next() },
    '../utils/attachmentContentPolicy.js': contentPolicy, '../attachments/lifecycleCore.js': lifecycleCore, '../attachments/lifecycle.js': { attachmentLifecycle: lifecycle },
    './protocol.js': protocol, './streamUpload.js': transport,
  }, f.env).default;
  const download = load('routes/conversations/attachments', {
    '../../db.js': { pool: f.pool }, '../../minio.js': storage, '../../media/range.js': range,
    '../../attachments/lifecycle.js': { ...lifecycleCore, attachmentLifecycle: lifecycle }, '../../attachments/rawUpload.js': rawUpload,
    '../../attachments/uploadProcessor.js': uploadProcessor, '../../utils/conversationInteraction.js': interaction,
    '../../middleware/rate_limit.js': { attachmentUploadLimiter: (_req, _res, next) => next() }, '../../utils/conversationIdentity.js': identity,
    '../../utils/groupPermissions.js': permissions, '../../utils/chatImageErrors.js': imageErrors, '../../utils/chatImageLimits.js': { MAX_CHAT_ATTACHMENT_BYTES: 10485760 },
    '../../attachmentSanitizer/client.js': { sanitizeChatAttachmentImageInWorker: async () => { throw new Error('Video called Sharp'); } },
    '../../sentinel/index.js': { __esModule: true, default: { guard: (_key, task) => task() }, createSentinelKey: (...args) => args.join(':') },
    '../../utils/attachmentContentPolicy.js': contentPolicy,
  }).default;
  const csrf = load('middleware/encryptedCSRF', { '../utils/authSecrets.js': { getCsrfEncryptionKey: () => Buffer.alloc(32, 7) } });
  const pair = csrf.generateEncryptedCSRFToken();
  const app = express(); app.use(cookieParser()); app.use(csrf.encryptedCSRFProtection);
  // Session boundary is supplied by the fixture. Production immutable-session
  // middleware is unchanged and covered separately by the security suite.
  app.use((req, _res, next) => { if ([user, outsider].includes(req.cookies.session)) req.user = { id: req.cookies.session }; next(); });
  app.use('/api/conversations/:conversationId/attachments/video-ingests', router);
  app.use('/api/conversations/:conversationId/attachments', download);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/conversations/732434999193640960/attachments`;
  const headers = { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': pair.plainToken, Cookie: `session=${user}; _csrf=${pair.encryptedToken}` };
  const post = (bytes, extra = {}) => fetch(`${base}/video-ingests`, { method: 'POST', headers: { ...headers, ...extra }, body: bytes });
  assert.equal((await post('x', { Cookie: `_csrf=${pair.encryptedToken}` })).status, 401);
  assert.equal((await post('x', { Cookie: `session=${outsider}; _csrf=${pair.encryptedToken}` })).status, 403);
  assert.equal((await post('x', { 'X-CSRF-Token': 'wrong' })).status, 403);
  await f.pool.query(`UPDATE conversations SET permissions='{"who_can_send_attachments":"owner"}' WHERE id=$1`, [conversation]);
  assert.equal((await post('x')).status, 403);
  await f.pool.query('UPDATE conversations SET permissions=NULL WHERE id=$1', [conversation]);
  assert.equal((await post(Buffer.alloc(0))).status, 400);
  assert.equal((await post(Buffer.alloc(10485761))).status, 413);
  assert.equal((await post('x', { 'X-Attachment-Filename': 'x'.repeat(2049) })).status, 400);
  assert.equal((await post('x', { 'Content-Type': 'application/json' })).status, 415);
  for (const knownLength of [true, false]) {
    const id = randomUUID();
    const partial = request(`${base}/video-ingests`, { method: 'POST', headers: {
      ...headers, 'X-Media-Ingest-Id': id, ...(knownLength ? { 'Content-Length': 1048576 } : {}),
    } });
    partial.on('error', () => {});
    partial.write(Buffer.alloc(65536));
    await until(async () => (await f.pool.query('SELECT status FROM media_ingests WHERE id=$1', [id])).rows[0]?.status === 'uploading');
    partial.destroy();
    await until(async () => (await f.pool.query('SELECT status FROM media_ingests WHERE id=$1', [id])).rows[0]?.status === 'failed');
    await assert.rejects(f.objects.statObject('quarantine', `video/${id}/source`), error => ['NoSuchKey', 'NotFound'].includes(error.code));
  }
  const path = join(f.directory, 'fixture.mp4');
  execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-t', '1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', path]);
  const bytes = readFileSync(path), ids = [randomUUID(), randomUUID()];
  publishUnavailable = true;
  for (const id of ids) {
    const response = await post(bytes, { 'X-Media-Ingest-Id': id }); assert.equal(response.status, 202);
    assert.equal((await response.json()).ingest_id, id);
  }
  assert.equal(await f.redis.xlen(protocol.VIDEO_STREAM), 0, 'failed publication must rely on DB recovery');
  assert.equal((await f.pool.query(`SELECT count(*) FROM media_ingests WHERE status='queued'`)).rows[0].count, '2');
  publishUnavailable = false;
  const executable = join(f.directory, 'media-worker');
  const localGo = join(homedir(), '.local/bin/go');
  execFileSync(process.env.GO_BIN || (existsSync(localGo) ? localGo : 'go'), ['build', '-o', executable, './media/entrypoint'], { cwd: root });
  f.start(executable, [], f.env);
  await until(async () => (await f.pool.query(`SELECT count(*) FROM media_ingests WHERE status='ready'`)).rows[0].count === '2', 40000);
  const delivery = load('utils/attachmentDelivery', { '../db.js': { pool: f.pool }, '../minio.js': storage,
    '../vmd/capability.js': { createVmdResponsiveImageDelivery() { throw new Error('Video requested VMD'); } },
    './attachmentDeliveryCore.js': deliveryCore, './attachmentContentPolicy.js': contentPolicy,
  }).attachSignedAttachmentUrls;
  const descriptors = [];
  for (const id of ids) {
    const status = await fetch(`${base}/video-ingests/${id}`, { headers }); assert.equal(status.status, 200);
    const result = await status.json(); assert.equal(result.status, 'ready'); assert.equal(result.attachment.mime, 'video/mp4');
    descriptors.push(JSON.stringify(result.attachment));
    const url = `${base}/${id}`;
    const full = await fetch(url, { headers }); assert.equal(full.status, 200); assert.equal(full.headers.get('Content-Type'), 'video/mp4');
    assert.equal(full.headers.get('Accept-Ranges'), 'bytes'); const normalized = Buffer.from(await full.arrayBuffer());
    for (const [request, start, end] of [['bytes=0-31', 0, 31], ['bytes=100-', 100, normalized.length-1], ['bytes=-80', normalized.length-80, normalized.length-1]]) {
      const response = await fetch(url, { headers: { ...headers, Range: request } }); assert.equal(response.status, 206);
      assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/${normalized.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), normalized.subarray(start,end+1));
    }
    for (const request of ['bytes=999999999-', 'bytes=4-1', 'bytes=0-1,3-4', 'bad']) {
      assert.equal((await fetch(url, { headers: { ...headers, Range: request } })).status, 416);
    }
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Cookie: `session=${outsider}` } })).status, 403);
    const poster = await fetch(`${url}/poster`, { headers }); assert.equal(poster.headers.get('Content-Type'), 'image/webp'); await poster.arrayBuffer();
  }
  const messages = await delivery([{ attachments: descriptors }], conversation);
  for (const raw of messages[0].attachments) {
    const a = JSON.parse(raw); assert.equal(a.video_trusted, true); assert.equal(a.inline, true); assert.ok(a.poster.url); assert.equal(a.display_url, undefined);
    const response = await fetch(a.url, { headers: { Range: 'bytes=0-7' } }); assert.equal(response.status, 206); await response.arrayBuffer();
  }
  const { chromium } = createRequire(new URL('../../../../VOID0000-www/package.json', import.meta.url))('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'session', value: user, url: base }]);
    await page.goto(`${base}/video-ingests/${ids[0]}`);
    const ranges = [];
    page.on('response', response => { if (response.url() === `${base}/${ids[0]}`) ranges.push(response.status()); });
    const dimensions = await page.evaluate(async url => {
      const video = globalThis.document.createElement('video'); video.controls = true; video.preload = 'metadata'; globalThis.document.body.replaceChildren(video);
      const loaded = new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('Normalized video decode failed')); });
      video.src = url; await loaded;
      await video.play(); video.pause();
      const seek = new Promise(resolve => { video.onseeked = resolve; }); video.currentTime = 0.5; await seek;
      return { width: video.videoWidth, height: video.videoHeight, time: video.currentTime };
    }, `${base}/${ids[0]}`);
    assert.deepEqual(dimensions, { width: 160, height: 90, time: 0.5 });
    assert.ok(ranges.includes(206), 'native video playback must use HTTP ranges');
  } finally { await browser.close(); }
  // Exact marker, never filename or MIME alone, controls inline delivery.
  for (const marker of [undefined, null, true, 'true', '0', '01']) {
    assert.equal(contentPolicy.resolveStoredAttachmentPolicy({ metaData: { 'content-type': 'video/mp4', 'void-sanitized-video': marker } }).inline, false);
  }
  const cancelId = randomUUID(); const saved = await post(randomBytes(1024), { 'X-Media-Ingest-Id': cancelId }); assert.equal(saved.status, 202);
  assert.equal((await fetch(`${base}/video-ingests/${cancelId}`, { method: 'DELETE', headers })).status, 204);
  assert.ok(['cancelled','failed'].includes((await f.pool.query('SELECT status FROM media_ingests WHERE id=$1',[cancelId])).rows[0].status));
});
