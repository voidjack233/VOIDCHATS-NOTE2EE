import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import sharp from 'sharp';

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
    if (sql.includes('json_agg')) return { rows: [{ id: 'dm', type: 'dm', members: [{
      user_id: 'peer', username: 'peer', display_name: 'Current name', nickname: 'Pet name', avatar_filename: filename,
    }] }] };
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
    assert.equal(dm.dm_nickname, 'Pet name');
  }
});

test('PROFILE_UPDATE fanout selects accepted friend IDs in both friendship directions', async () => {
  const published = [];
  const gateway = load('gateway/client', {
    '../valkey.js': {}, './presenceMode.js': {},
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
