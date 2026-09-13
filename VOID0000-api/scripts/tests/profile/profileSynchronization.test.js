import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

// Execute the real modules, with isolated storage/transport doubles. Never write production data.
const require = createRequire(import.meta.url);
function load(path, dependencies = {}) {
  const source = readFileSync(new URL(`../../../server/${path}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  runInNewContext(output, { exports, Buffer, console, setTimeout, clearTimeout,
    process: { env: { CDN_URL: 'https://cdn.example.test' } },
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier];
      if (['express', 'sharp'].includes(specifier)) return require(specifier);
      throw new Error(`Unexpected dependency: ${specifier}`);
    },
  });
  return exports;
}
const avatars = load('utils/avatarFallback');
const presence = { getBulkUserPresence: async () => new Map() };
const normalizeConversationRow = row => ({ ...row, dm_avatar_url: avatars.resolveUserAvatarUrl(row.dm_avatar) });
async function invoke(router, params = {}) {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await router.stack.find(layer => layer.route).route.stack.at(-1).handle({ user: { id: 'viewer' }, params }, res);
  assert.equal(res.code, 200);
  return res.body;
}

test('avatar worker persists filename before invalidation, old-object deletion and completion', async () => {
  const steps = [];
  let persisted;
  let processor;
  const imageQueue = load('queues/imageQueue', {
    bullmq: { Queue: class {}, QueueEvents: class {}, Worker: class {
      constructor(_name, task) { processor = task; } on() {}
    } },
    '../db.js': { pool: { async query(sql, [filename, profileId]) {
      assert.match(sql, /UPDATE user_profiles[\s\S]*avatar_filename = \$1[\s\S]*WHERE id = \$2/);
      assert.equal(profileId, '202'); persisted = filename; steps.push('persist');
    } } },
    '../minio.js': { BUCKET: 'avatars', minioClient: {
      async putObject() { steps.push('upload'); },
      async removeObject() { assert.ok(persisted); steps.push('delete-old'); },
    } },
    '../middleware/profileCache.js': { profileCache: { async invalidate() { assert.ok(persisted); steps.push('invalidate'); } } },
    '../utils/debugLog.js': { debugLog() {} },
    '../imageProcessing/sharpWorkGate.js': { runSharpWork: task => task() },
  });
  imageQueue.startImageWorker();
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const result = await processor({ data: { userId: 'peer', profileId: '202', imageData: image.toString('base64'), oldFilename: 'old.webp' } });
  assert.equal(result.filename, persisted);
  assert.deepEqual(steps, ['upload', 'persist', 'invalidate', 'delete-old']);
});

test('fresh bootstrap, friends, list and details resolve the current persisted filename', async () => {
  let filename = 'avatar-202-before.webp';
  const query = async sql => {
    if (sql.includes('FROM user_preferences')) return { rows: [] };
    if (sql.includes("status = 'pending'")) return { rows: [] };
    assert.match(sql, /up.avatar_filename/);
    if (sql.includes('json_agg')) {
      assert.match(sql, /'profile_id', u.profile_id::text/);
      return { rows: [{ id: 'dm', type: 'dm', members: [{
      user_id: 'peer', username: 'peer', display_name: 'Current name', nickname: 'Pet name', avatar_filename: filename,
      profile_id: '732434999193640961',
    }] }] };
    }
    if (sql.includes('FROM conversations c')) {
      assert.match(sql, /END AS dm_nickname/);
      return { rows: [{ id: 'dm', type: 'dm', dm_avatar: filename, dm_nickname: 'Pet name' }] };
    }
    return { rows: [{ id: 'peer', username: 'peer', avatar_filename: filename }] };
  };
  const pool = { query };
  const list = load('routes/conversations/root/list', {
    '../../../db.js': { pool }, './shared.js': { normalizeConversationRow },
    '../messages/shared.js': { cassandra: { types: { Uuid: { fromString: id => id } } }, scylla: { execute: async () => ({ rows: [] }) } },
  });
  const bootstrap = load('routes/bootstrap', {
    '../db.js': { pool }, '../gateway/client.js': presence,
    './conversations/root/list.js': list, '../utils/avatarFallback.js': avatars,
    '../gateway/presenceMode.js': { cachePresenceMode: async () => {} },
  });
  const friends = load('routes/friends/list', {
    '../../db.js': { pool }, '../../gateway/client.js': presence, '../../utils/avatarFallback.js': avatars,
  });
  const details = load('routes/conversations/root/details', {
    '../../../db.js': { pool }, '../../../utils/avatarFallback.js': avatars,
    '../../../utils/conversationIdentity.js': { findConversationByIdentifier: async () => ({ id: 'dm' }) },
    './shared.js': { normalizeConversationRow, getConversationMemberRole: async () => 'member' },
  });
  for (const current of ['avatar-202-before.webp', 'avatar-202-after.webp', null]) {
    filename = current;
    const expected = avatars.resolveUserAvatarUrl(current);
    const fresh = await invoke(bootstrap.default);
    assert.equal(fresh.account.avatar_url, expected);
    assert.equal(fresh.friends[0].avatar_url, expected);
    assert.equal(fresh.conversations[0].dm_avatar_url, expected);
    assert.equal(fresh.conversations[0].dm_nickname, 'Pet name');
    assert.equal((await invoke(friends.default)).friends[0].avatar_url, expected);
    const dm = (await invoke(details.default, { conversationId: 'dm' })).conversation;
    assert.equal(dm.dm_avatar_url, expected);
    assert.equal(dm.members[0].avatar_url, expected);
    assert.equal(dm.members[0].profile_id, '732434999193640961');
    assert.equal(dm.dm_nickname, 'Pet name');
  }
});

test('unrelated friend-only fanout keeps accepted friend IDs in both friendship directions', async () => {
  const published = [];
  const gateway = load('gateway/client', {
    '../valkey.js': {}, './presenceMode.js': {},
    './protocol.js': { EVENTS: { PROFILE_UPDATE: 'PROFILE_UPDATE' } },
    '../db.js': { pool: { async query(sql, [userId]) {
      assert.equal(userId, 'editor');
      assert.match(sql, /CASE[\s\S]*requester_id = \$1[\s\S]*addressee_id[\s\S]*ELSE requester_id/);
      assert.match(sql, /status = 'accepted'/);
      return { rows: [{ friend_id: 'friend-requester' }, { friend_id: 'friend-addressee' }] };
    } } },
    '../valkey-pubsub.js': { publishToGateway: (...args) => published.push(args) },
  });
  const payload = { user_id: 'editor', profile_id: '202', display_name: 'New', avatar_url: 'new.webp' };
  gateway.broadcastLiveEventToFriends('editor', 'PROFILE_UPDATE', payload);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(published, [
    ['PROFILE_UPDATE', 'friend-requester', payload],
    ['PROFILE_UPDATE', 'friend-addressee', payload],
  ]);
});

test('profile audience SQL deduplicates current friends/groups/DMs and excludes outsiders/removed members', { timeout: 60_000 }, async () => {
  // A disposable PostgreSQL cluster, not the app database or its environment.
  const root = mkdtempSync(join(tmpdir(), 'void-profile-sql-'));
  const bin = process.env.PROFILE_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
  let started = false;
  let client;
  try {
    execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-l', join(root, 'log'), '-o', `-k ${root} -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    client = new pg.Client({ host: root, port: 5432, database: 'postgres', user: process.env.USER });
    await client.connect();
    await client.query(`CREATE TABLE friendships(requester_id text, addressee_id text, status text);
      CREATE TABLE conversations(id text PRIMARY KEY, type text);
      CREATE TABLE conversation_members(conversation_id text, user_id text);
      INSERT INTO friendships VALUES ('editor','both','accepted'),('friend','editor','accepted'),('editor','pending','pending');
      INSERT INTO conversations VALUES ('g1','group'),('g2','group'),('dm','dm'),('other','group');
      INSERT INTO conversation_members VALUES
        ('g1','editor'),('g1','both'),('g1','group-only'),('g1','leaving'),
        ('g2','editor'),('g2','both'),('g2','group-only'),
        ('dm','editor'),('dm','dm-only'),('other','outsider');`);
    let queryCount = 0;
    const published = [];
    const gateway = load('gateway/client', {
      '../valkey.js': {}, './presenceMode.js': {},
      './protocol.js': { EVENTS: { PROFILE_UPDATE: 'PROFILE_UPDATE' } },
      '../db.js': { pool: { query: (...args) => { queryCount++; return client.query(...args); } } },
      '../valkey-pubsub.js': { publishToGateway: (...args) => published.push(args) },
    });
    const payload = { user_id: 'editor', profile_id: '732434999193640961', display_name: 'New', avatar_url: 'new.webp' };
    await gateway.broadcastProfileUpdate('editor', payload);
    assert.equal(queryCount, 1);
    assert.deepEqual(published.map(([, id]) => id).sort(), ['both', 'dm-only', 'friend', 'group-only', 'leaving']);
    assert.ok(published.every(([event, , data]) => event === 'PROFILE_UPDATE' && data === payload));
    published.length = 0;
    await client.query("DELETE FROM conversation_members WHERE user_id = 'leaving'");
    await gateway.broadcastProfileUpdate('editor', payload);
    assert.equal(queryCount, 2);
    assert.deepEqual(published.map(([, id]) => id).sort(), ['both', 'dm-only', 'friend', 'group-only']);
    published.length = 0;
    await client.query("DELETE FROM conversation_members WHERE user_id = 'editor'");
    await gateway.broadcastProfileUpdate('editor', payload);
    assert.deepEqual(published.map(([, id]) => id).sort(), ['both', 'friend']);

    const { rows } = await client.query(`SELECT json_build_object('profile_id', 732434999193640961::bigint) AS unsafe,
      json_build_object('profile_id', 732434999193640961::bigint::text) AS safe`);
    assert.notEqual(String(rows[0].unsafe.profile_id), '732434999193640961');
    assert.equal(rows[0].safe.profile_id, '732434999193640961');
  } finally {
    await client?.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(root, { recursive: true, force: true });
  }
});

test('name/bio edits, avatar uploads and avatar removal all use the profile-only audience', async () => {
  const published = [];
  const profile = { profile_id: '732434999193640961', display_name: 'New name', bio: 'New bio', username: 'editor' };
  const deps = {
    '../../db.js': { pool: { query: async () => ({ rows: [{ ...profile, avatar_filename: null }] }) } },
    '../../gateway/client.js': { broadcastProfileUpdate: (...args) => published.push(args) },
    '../../middleware/profileCache.js': { profileCache: { invalidate: async () => {} } },
    '../../middleware/rate_limit.js': { profileUpdateLimiter: (_req, _res, next) => next(), avatarUploadLimiter: (_req, _res, next) => next() },
    '../../queues/imageQueue.js': { queueImageUpload: async () => ({ job: { waitUntilFinished: async () => ({ filename: 'new.webp' }) } }), imageQueueEvents: {} },
    '../../minio.js': { minioClient: {}, BUCKET: 'avatars' },
    '../../utils/avatarFallback.js': avatars,
  };
  const fields = load('routes/user/profileFields', deps).default;
  const avatar = load('routes/user/profileAvatar', deps).default;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  for (const [router, method, path, body, expectedAvatar] of [
    [fields, 'put', '/profile', { display_name: 'New name', bio: 'New bio' }, undefined],
    [avatar, 'put', '/profile/avatar', { avatar: `data:image/png;base64,${png.toString('base64')}` }, 'https://cdn.example.test/avatars/new.webp'],
    [avatar, 'delete', '/profile/avatar', {}, null],
  ]) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    const handler = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
    await handler({ userId: 'editor', userProfileId: profile.profile_id, body }, res);
    assert.equal(res.code, 200);
    const [recipient, event] = published.at(-1);
    assert.equal(recipient, 'editor');
    assert.equal(event.profile_id, profile.profile_id);
    assert.equal(event.display_name, 'New name');
    assert.equal(event.avatar_url, expectedAvatar);
  }
  assert.equal(published.length, 3);
});
