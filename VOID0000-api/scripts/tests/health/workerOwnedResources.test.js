import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStagedAttachmentCleanupRunner } from '../../../server/attachments/cleanup.js';
import { createAttachmentReservationReconciliationRunner } from '../../../server/attachments/reservationReconciliation.js';
import { startAttachmentSanitizerServer } from '../../../server/attachmentSanitizer/server.js';
import { startVmdTransformServer } from '../../../server/vmd/transformServer.js';
import { encodeControlFrame, SocketFrameReader, writeSocket } from '../../../server/attachmentSanitizer/ipcProtocol.js';
import { load } from '../media/fixtures.js';
import { waitFor } from './scyllaShutdownFixture.js';

function deferred() { return Promise.withResolvers(); }

for (const type of ['staged cleanup', 'reservation reconciliation']) {
  for (const fails of [false, true]) {
    test(`${type} stop waits for active work and lease release${fails ? ' on failure' : ''}`, async () => {
      const entered = deferred(), release = deferred();
      let leaseReleases = 0, stopped = false;
      const failure = new Error('Active work failed');
      const work = async () => { entered.resolve(); await release.promise; if (fails) throw failure; return {}; };
      const lockClient = { set: async () => 'OK', get: async () => '', del: async () => 1,
        eval: async () => { leaseReleases++; return 1; } };
      const runner = type === 'staged cleanup'
        ? createStagedAttachmentCleanupRunner({ lockClient, lifecycle: {
          config: { cleanupIntervalSeconds: 900 }, cleanupExpiredStaged: work, cleanupOrphanedBlobs: async () => ({}),
          cleanupUntrackedContentAddressedObjects: async () => ({ scanComplete: true, nextCursor: null }),
        } })
        : createAttachmentReservationReconciliationRunner({ lockClient, reconciler: { runOnce: work }, intervalSeconds: 900 });
      runner.start();
      const run = runner.runOnce();
      const runResult = fails ? assert.rejects(run, (error) => error === failure) : run;
      await entered.promise;
      const stopping = runner.stop();
      const stopResult = fails ? assert.rejects(stopping, (error) => error === failure) : stopping.then(() => { stopped = true; });
      await Promise.resolve();
      assert.equal(stopped, false); assert.equal(leaseReleases, 0);
      release.resolve();
      await Promise.all([runResult, stopResult]);
      assert.equal(leaseReleases, 1);
    });
  }
}

async function ipcRequest(path, operation) {
  const socket = net.createConnection(path);
  const reader = new SocketFrameReader(socket, { maxBufferedBytes: 4096 });
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    await writeSocket(socket, encodeControlFrame({ version: 1, operation, payloadLength: 1,
      ...(operation === 'sanitize' ? { claimedMime: 'image/png' } : { variant: 'small' }) }));
    assert.equal((await reader.readControlFrame()).type, 'ready');
    await writeSocket(socket, Buffer.from([1]));
    return await reader.readControlFrame();
  } finally { reader.dispose(); socket.destroy(); }
}

for (const operation of ['sanitize', 'transform']) {
  test(`${operation} IPC close rejects queued requests and waits for active computation`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'void-worker-owner-'));
    const socketPath = join(directory, 'work.sock');
    const entered = deferred(), release = deferred();
    let calls = 0, closed = false;
    const work = async () => { calls++; entered.resolve(); await release.promise; return null; };
    const options = { socketPath, concurrency: 1, runSharpWork: (task) => task() };
    const server = operation === 'sanitize'
      ? await startAttachmentSanitizerServer({ ...options, sanitize: work })
      : await startVmdTransformServer({ ...options, transform: work });
    t.after(async () => { release.resolve(); await server.close(); await rm(directory, { recursive: true, force: true }); });
    const first = ipcRequest(socketPath, operation);
    const firstRejection = assert.rejects(first);
    await entered.promise;
    const second = ipcRequest(socketPath, operation);
    const secondRejection = assert.rejects(second);
    await waitFor(() => server.getStats().queued === 1);
    const closing = server.close();
    assert.equal(server.close(), closing, 'concurrent close must share its drain');
    closing.then(() => { closed = true; });
    await Promise.all([firstRejection, secondRejection]);
    assert.equal(closed, false); assert.equal(calls, 1);
    assert.equal(server.getStats().active, 1); assert.equal(server.getStats().queued, 0);
    release.resolve(); await closing;
    assert.equal(server.getStats().active, 0); assert.equal(server.getStats().pendingBytes, 0);
  });
}

test('presence close stops intake and drains handlers before publisher/PG cleanup', async () => {
  const entered = deferred(), release = deferred();
  const published = [];
  let subscriber;
  class TestRedis extends EventEmitter {
    constructor() { super(); subscriber = this; }
    subscribe(channel, callback) { callback(null); }
    async quit() { this.ended = true; }
  }
  const presence = load('gateway/presence-fanout', {
    ioredis: { Redis: TestRedis }, './protocol.js': { EVENTS: { PRESENCE_UPDATE: 'presence' } },
    '../utils/debugLog.js': { debugLog() {} },
    '../db.js': { pool: { query: async () => { entered.resolve(); await release.promise; return { rows: [{ friend_id: 'friend' }] }; } } },
    '../valkey-pubsub.js': { publishToGateway: (...args) => published.push(args) },
  });
  presence.initPresenceFanout();
  subscriber.emit('message', 'void:presence_change', JSON.stringify({ userId: 'user', status: 'online' }));
  await entered.promise;
  let closed = false;
  const closing = presence.closePresenceFanout(); closing.then(() => { closed = true; });
  assert.equal(presence.closePresenceFanout(), closing);
  assert.equal(subscriber.listenerCount('message'), 0);
  await Promise.resolve(); assert.equal(closed, false); assert.equal(published.length, 0);
  release.resolve(); await closing;
  assert.equal(subscriber.ended, true); assert.equal(published.length, 1);
});
