import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRESENCE_MODE_OPTIONS,
  isPresenceMode,
  isPubliclyActive,
  normalizePresenceMode,
  resolveOwnPresenceStatus,
} from '../../../src/Services/Presence/presenceStatus';
import { createAppBootstrapStore, type AppBootstrap } from '../../../src/Services/bootstrap';

test('online follows activity while explicit presence modes override it', () => {
  assert.equal(resolveOwnPresenceStatus('online', 'online'), 'online');
  assert.equal(resolveOwnPresenceStatus('online', 'idle'), 'idle');
  assert.equal(resolveOwnPresenceStatus('idle', 'online'), 'idle');
  assert.equal(resolveOwnPresenceStatus('dnd', 'online'), 'dnd');
  assert.equal(resolveOwnPresenceStatus('invisible', 'online'), 'offline');
});

test('presence mode validation fails closed to online', () => {
  assert.equal(isPresenceMode('dnd'), true);
  assert.equal(isPresenceMode('offline'), false);
  assert.equal(normalizePresenceMode(null), 'online');
  assert.equal(normalizePresenceMode('unknown'), 'online');
  assert.equal(normalizePresenceMode('auto'), 'online');
  assert.deepEqual(
    PRESENCE_MODE_OPTIONS.map(({ mode }) => mode),
    ['online', 'idle', 'dnd', 'invisible'],
  );
  assert.equal(isPubliclyActive('dnd'), true);
  assert.equal(isPubliclyActive('offline'), false);
});

test('updating presence patches the shared bootstrap preferences cache', async () => {
  const bootstrap: AppBootstrap = {
    success: true,
    user: { id: 'user-1' },
    account: {},
    preferences: { theme: 'void', presence_mode: 'online' },
    friends: [],
    friend_requests: { incoming: [], outgoing: [] },
    conversations: [],
  };
  const store = createAppBootstrapStore(async () => ({
    status: 'success',
    bootstrap,
  }));

  await store.load();
  store.updatePreferences({ presence_mode: 'dnd' });

  assert.deepEqual(store.getCached()?.preferences, {
    theme: 'void',
    presence_mode: 'dnd',
  });
});
