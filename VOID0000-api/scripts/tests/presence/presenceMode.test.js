import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPresenceMode,
  normalizePresenceMode,
  normalizePresenceSnapshot,
  persistPresenceMode,
  presenceModeKey,
} from '../../../server/gateway/presenceMode.js';

test('accepts only the supported account presence modes', () => {
  for (const mode of ['online', 'idle', 'dnd', 'invisible']) {
    assert.equal(isPresenceMode(mode), true);
    assert.equal(normalizePresenceMode(mode), mode);
  }

  for (const mode of ['offline', '', null, undefined, 0, 'busy']) {
    assert.equal(isPresenceMode(mode), false);
    assert.equal(normalizePresenceMode(mode), 'online');
  }

  assert.equal(isPresenceMode('auto'), false);
  assert.equal(normalizePresenceMode('auto'), 'online');
});

test('public snapshots preserve DND and allow an active invisible user to appear offline', () => {
  assert.deepEqual(
    normalizePresenceSnapshot({ status: 'dnd', lastActive: 123 }, 2),
    { status: 'dnd', lastActive: 123, activeCount: 2 },
  );
  assert.deepEqual(
    normalizePresenceSnapshot({ status: 'offline', lastActive: 456 }, 1),
    { status: 'offline', lastActive: 456, activeCount: 1 },
  );
  assert.equal(
    normalizePresenceSnapshot({ status: 'dnd', lastActive: 123 }, 0).status,
    'offline',
  );
});

test('persists the preference before synchronizing cache and live sockets', async () => {
  const operations = [];
  const dbPool = {
    async query(sql, params) {
      operations.push(['postgres', params]);
      assert.match(sql, /ON CONFLICT \(user_id\)/);
      return { rows: [{ presence_mode: params[1] }] };
    },
  };

  const persistedMode = await persistPresenceMode({
    dbPool,
    userId: 'user-1',
    mode: 'invisible',
    cacheMode: async (userId, mode) => {
      operations.push(['valkey', userId, mode]);
      return true;
    },
    publishCommand: (command, data) => {
      operations.push(['gateway', command, data]);
    },
  });

  assert.equal(persistedMode, 'invisible');
  assert.deepEqual(operations, [
    ['postgres', ['user-1', 'invisible']],
    ['valkey', 'user-1', 'invisible'],
    ['gateway', 'updatePresenceMode', { userId: 'user-1', mode: 'invisible' }],
  ]);
  assert.equal(presenceModeKey('user-1'), 'presence_mode:user-1');
});

test('rejects invalid modes without touching persistence or fanout', async () => {
  let calls = 0;

  await assert.rejects(
    persistPresenceMode({
      dbPool: { query: async () => { calls += 1; } },
      userId: 'user-1',
      mode: 'offline',
      cacheMode: async () => { calls += 1; },
      publishCommand: () => { calls += 1; },
    }),
    (error) => error?.code === 'INVALID_PRESENCE_MODE',
  );

  assert.equal(calls, 0);
});
