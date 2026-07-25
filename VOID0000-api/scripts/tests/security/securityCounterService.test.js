import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';

import valkey from '../../../server/valkey.js';
import {
  SecurityCounterUnavailableError,
  clearFixedWindowCounters,
  getFixedWindowCounterState,
  incrementFixedWindowCounters,
} from '../../../server/auth/services/securityCounterService.js';

after(async () => {
  await valkey.quit();
});

function createKey(label) {
  return `test:security-counter:${label}:${crypto.randomUUID()}`;
}

test('twenty concurrent increments are preserved and block at the threshold', async (t) => {
  const key = createKey('concurrency');
  t.after(() => clearFixedWindowCounters(key));

  const states = await Promise.all(Array.from({ length: 20 }, () => (
    incrementFixedWindowCounters({
      keys: key,
      maxAttempts: 5,
      windowSeconds: 30,
    })
  )));
  const finalState = await getFixedWindowCounterState({
    keys: key,
    maxAttempts: 5,
  });

  assert.equal(finalState.attempts, 20);
  assert.equal(finalState.exhausted, true);
  assert.equal(states.filter((state) => state.exhausted).length, 16);
});

test('later increments preserve rather than reset the fixed-window TTL', async (t) => {
  const key = createKey('ttl');
  t.after(() => clearFixedWindowCounters(key));

  await incrementFixedWindowCounters({
    keys: key,
    maxAttempts: 10,
    windowSeconds: 5,
  });
  const initialTtl = await valkey.ttl(key);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await incrementFixedWindowCounters({
    keys: key,
    maxAttempts: 10,
    windowSeconds: 5,
  });
  const finalTtl = await valkey.ttl(key);

  assert.ok(initialTtl > 0);
  assert.ok(finalTtl > 0);
  assert.ok(finalTtl < initialTtl);
});

test('an increment during the final sub-second does not restart the window', async (t) => {
  const key = createKey('sub-second-ttl');
  t.after(() => clearFixedWindowCounters(key));

  await incrementFixedWindowCounters({
    keys: key,
    maxAttempts: 10,
    windowSeconds: 5,
  });
  await valkey.pexpire(key, 400);
  await incrementFixedWindowCounters({
    keys: key,
    maxAttempts: 10,
    windowSeconds: 5,
  });
  const finalTtlMilliseconds = await valkey.pttl(key);

  assert.ok(finalTtlMilliseconds > 0);
  assert.ok(finalTtlMilliseconds <= 400);
});

test('counter backend failures are surfaced instead of allowing the action', async () => {
  const failingClient = {
    async eval() {
      throw new Error('valkey unavailable');
    },
  };

  await assert.rejects(
    incrementFixedWindowCounters({
      keys: createKey('failure'),
      maxAttempts: 5,
      windowSeconds: 60,
      client: failingClient,
    }),
    SecurityCounterUnavailableError,
  );
});
