import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AttachmentLifecycleError,
  DEFAULT_ATTACHMENT_CLEANUP_BATCH_SIZE,
  DEFAULT_ATTACHMENT_RECONCILIATION_BATCH_SIZE,
  DEFAULT_STAGED_ATTACHMENT_MAX_BYTES,
  DEFAULT_STAGED_ATTACHMENT_MAX_COUNT,
  assertStagedUploadQuota,
  createAttachmentLifecycle,
  extractProtectedAttachmentIds,
  resolveAttachmentLifecycleConfig,
} from '../../../server/attachments/lifecycleCore.js';
import { createStagedAttachmentCleanupRunner } from '../../../server/attachments/cleanup.js';
import { RATE_LIMIT_POLICIES } from '../../../server/middleware/rateLimits/policies.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const ATTACHMENT_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_ATTACHMENT_ID = '66666666-6666-4666-8666-666666666666';
const MESSAGE_ID = '77777777-7777-1777-8777-777777777777';
const SECOND_MESSAGE_ID = '88888888-8888-1888-8888-888888888888';
const NOW = new Date('2026-07-30T00:00:00.000Z');

function descriptor(attachmentId = ATTACHMENT_ID) {
  return JSON.stringify({
    url: `/api/conversations/public-id/attachments/${attachmentId}`,
    mime: 'image/jpeg',
    size: 1234,
  });
}

function lifecycleConfig(overrides = {}) {
  return {
    stagedTtlSeconds: 3600,
    reservationTtlSeconds: 300,
    stagedMaxCount: 25,
    stagedMaxBytes: 100 * 1024 * 1024,
    cleanupIntervalSeconds: 900,
    cleanupBatchSize: 50,
    reconciliationBatchSize: 25,
    ...overrides,
  };
}

class Mutex {
  tail = Promise.resolve();

  async acquire() {
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => current);
    await previous;
    return release;
  }
}

function createMemoryInfrastructure(initialRows = []) {
  const rows = new Map(initialRows.map((row) => [
    String(row.id).toLowerCase(),
    {
      bucket: 'chat-attachments',
      object_key: `${row.conversation_id}/${row.id}.bin`,
      size_bytes: 1234,
      staged_at: NOW,
      expires_at: new Date(NOW.getTime() + 3600_000),
      reserved_at: null,
      reserved_until: null,
      reservation_id: null,
      committed_at: null,
      message_id: null,
      ...row,
      id: String(row.id).toLowerCase(),
    },
  ]));
  const objects = new Set([...rows.values()].map((row) => row.object_key));
  const failedObjectDeletes = new Set();
  const mutex = new Mutex();

  async function execute(sql, params = []) {
    const query = sql.replace(/\s+/g, ' ').trim();

    if (
      query === 'BEGIN' ||
      query === 'COMMIT' ||
      query === 'ROLLBACK' ||
      query.startsWith('SELECT pg_advisory_xact_lock')
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (query.startsWith('SELECT COUNT(*)::int AS staged_count')) {
      const matching = [...rows.values()].filter((row) => (
        row.uploader_id === params[0] && row.status === 'staged'
      ));
      return {
        rows: [{
          staged_count: matching.length,
          staged_bytes: matching.reduce((total, row) => total + Number(row.size_bytes || 0), 0),
        }],
        rowCount: 1,
      };
    }

    if (query.startsWith('INSERT INTO attachment_objects')) {
      const [id, conversationId, uploaderId, bucket, objectKey, sizeBytes, ttlSeconds] = params;
      rows.set(String(id).toLowerCase(), {
        id: String(id).toLowerCase(),
        conversation_id: conversationId,
        uploader_id: uploaderId,
        bucket,
        object_key: objectKey,
        status: 'staged',
        size_bytes: sizeBytes,
        staged_at: new Date(NOW),
        expires_at: new Date(NOW.getTime() + ttlSeconds * 1000),
        reserved_at: null,
        reserved_until: null,
        reservation_id: null,
        committed_at: null,
        message_id: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (
      query.startsWith('SELECT id, conversation_id, uploader_id, bucket, object_key, status') &&
      query.includes('WHERE id = $1')
    ) {
      const row = rows.get(String(params[0]).toLowerCase());
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }

    if (
      query.startsWith('SELECT id FROM attachment_objects') &&
      query.includes('reservation_id = $3')
    ) {
      const matching = [...rows.values()].filter((row) => (
        row.uploader_id === params[0] &&
        row.conversation_id === params[1] &&
        row.reservation_id === params[2]
      ));
      return {
        rows: matching.map((row) => ({ id: row.id })),
        rowCount: matching.length,
      };
    }

    if (query.includes('expires_at <= NOW() AS is_expired')) {
      const matching = params[0]
        .map((id) => rows.get(String(id).toLowerCase()))
        .filter(Boolean)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((row) => ({
          ...row,
          message_id: row.message_id ? String(row.message_id) : null,
          is_expired: row.expires_at <= NOW,
          reservation_expired: row.reserved_until ? row.reserved_until <= NOW : false,
        }));
      return { rows: matching, rowCount: matching.length };
    }

    if (
      query.startsWith('UPDATE attachment_objects') &&
      query.includes("SET status = 'reserved'")
    ) {
      const [ids, reservationId, messageId, ttlSeconds] = params;
      const updated = [];
      for (const id of ids) {
        const row = rows.get(String(id).toLowerCase());
        if (row?.status !== 'staged' || row.expires_at <= NOW) continue;
        Object.assign(row, {
          status: 'reserved',
          reserved_at: new Date(NOW),
          reserved_until: new Date(NOW.getTime() + ttlSeconds * 1000),
          reservation_id: reservationId,
          message_id: messageId,
        });
        updated.push({ id: row.id });
      }
      return { rows: updated, rowCount: updated.length };
    }

    if (
      query.startsWith('UPDATE attachment_objects') &&
      query.includes("SET status = 'committed'")
    ) {
      const [ids, reservationId, messageId] = params;
      const updated = [];
      for (const id of ids) {
        const row = rows.get(String(id).toLowerCase());
        if (
          row?.status !== 'reserved' ||
          row.reservation_id !== reservationId ||
          row.message_id !== messageId
        ) {
          continue;
        }
        Object.assign(row, {
          status: 'committed',
          committed_at: new Date(NOW),
          reserved_until: null,
        });
        updated.push({ id: row.id });
      }
      return { rows: updated, rowCount: updated.length };
    }

    if (
      query.startsWith('UPDATE attachment_objects') &&
      query.includes("SET status = 'staged'")
    ) {
      const [ids, reservationId, messageId] = params;
      let rowCount = 0;
      for (const id of ids) {
        const row = rows.get(String(id).toLowerCase());
        if (
          row?.status !== 'reserved' ||
          row.reservation_id !== reservationId ||
          row.message_id !== messageId
        ) {
          continue;
        }
        Object.assign(row, {
          status: 'staged',
          reserved_at: null,
          reserved_until: null,
          reservation_id: null,
          message_id: null,
        });
        rowCount += 1;
      }
      return { rows: [], rowCount };
    }

    if (
      query.startsWith('SELECT id FROM attachment_objects') &&
      query.includes("status = 'staged'") &&
      query.includes('ORDER BY expires_at')
    ) {
      const candidates = [...rows.values()]
        .filter((row) => row.status === 'staged' && row.expires_at <= NOW)
        .sort((left, right) => left.expires_at - right.expires_at)
        .slice(0, params[0])
        .map((row) => ({ id: row.id }));
      return { rows: candidates, rowCount: candidates.length };
    }

    if (
      query.startsWith('SELECT id, bucket, object_key') &&
      query.includes("status = 'staged'")
    ) {
      const row = rows.get(String(params[0]).toLowerCase());
      const eligible = row?.status === 'staged' && row.expires_at <= NOW;
      return { rows: eligible ? [{ ...row }] : [], rowCount: eligible ? 1 : 0 };
    }

    if (
      query.startsWith('DELETE FROM attachment_objects') &&
      query.includes("status = 'staged'")
    ) {
      const id = String(params[0]).toLowerCase();
      const row = rows.get(id);
      if (row?.status !== 'staged') {
        return { rows: [], rowCount: 0 };
      }
      rows.delete(id);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled test query: ${query}`);
  }

  const dbPool = {
    async query(sql, params) {
      return execute(sql, params);
    },
    async connect() {
      let releaseTransaction = null;
      return {
        async query(sql, params) {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          if (normalized === 'BEGIN') {
            releaseTransaction = await mutex.acquire();
          }
          const result = await execute(sql, params);
          if ((normalized === 'COMMIT' || normalized === 'ROLLBACK') && releaseTransaction) {
            releaseTransaction();
            releaseTransaction = null;
          }
          return result;
        },
        release() {
          releaseTransaction?.();
          releaseTransaction = null;
        },
      };
    },
  };

  const objectStore = {
    async removeObject(_bucket, objectKey) {
      if (failedObjectDeletes.has(objectKey)) {
        throw new Error('simulated MinIO failure');
      }
      objects.delete(objectKey);
    },
  };

  return {
    dbPool,
    failedObjectDeletes,
    objectStore,
    objects,
    rows,
  };
}

function createTestLifecycle(infrastructure, configOverrides = {}) {
  return createAttachmentLifecycle({
    dbPool: infrastructure.dbPool,
    objectStore: infrastructure.objectStore,
    bucket: 'chat-attachments',
    config: lifecycleConfig(configOverrides),
    logger: { error() {} },
  });
}

test('attachment lifecycle configuration and upload limiter use bounded safe defaults', () => {
  const config = resolveAttachmentLifecycleConfig({
    ATTACHMENT_STAGED_TTL_SECONDS: 'invalid',
    ATTACHMENT_STAGED_MAX_COUNT: '0',
    ATTACHMENT_STAGED_MAX_BYTES: '-1',
    ATTACHMENT_CLEANUP_BATCH_SIZE: '999999',
    ATTACHMENT_RESERVATION_RECONCILIATION_BATCH_SIZE: '999999',
  });

  assert.equal(config.stagedMaxCount, DEFAULT_STAGED_ATTACHMENT_MAX_COUNT);
  assert.equal(config.stagedMaxBytes, DEFAULT_STAGED_ATTACHMENT_MAX_BYTES);
  assert.equal(config.cleanupBatchSize, DEFAULT_ATTACHMENT_CLEANUP_BATCH_SIZE);
  assert.equal(
    config.reconciliationBatchSize,
    DEFAULT_ATTACHMENT_RECONCILIATION_BATCH_SIZE,
  );
  assert.equal(RATE_LIMIT_POLICIES.attachmentUpload.scope, 'user');
  assert.equal(RATE_LIMIT_POLICIES.attachmentUpload.bucketSize, 30);
});

test('protected attachment parsing rejects malformed, external, and duplicate references', () => {
  assert.deepEqual(extractProtectedAttachmentIds([descriptor()]), [ATTACHMENT_ID]);
  assert.throws(
    () => extractProtectedAttachmentIds(['https://evil.invalid/file.jpg']),
    { code: 'ATTACHMENT_REFERENCE_EXTERNAL' },
  );
  assert.throws(
    () => extractProtectedAttachmentIds(['{"url":']),
    { code: 'ATTACHMENT_REFERENCE_INVALID' },
  );
  assert.throws(
    () => extractProtectedAttachmentIds([descriptor(), descriptor()]),
    { code: 'ATTACHMENT_DUPLICATE' },
  );
});

test('new uploads are staged with expiry and race-safe staged quota accounting', async () => {
  const infrastructure = createMemoryInfrastructure();
  const lifecycle = createTestLifecycle(infrastructure);

  await lifecycle.stageUploadedAttachments({
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    attachments: [{
      id: ATTACHMENT_ID,
      objectKey: `${CONVERSATION_ID}/${ATTACHMENT_ID}.bin`,
      sizeBytes: 2048,
    }],
  });

  const row = infrastructure.rows.get(ATTACHMENT_ID);
  assert.equal(row.status, 'staged');
  assert.equal(row.size_bytes, 2048);
  assert.equal(row.staged_at.toISOString(), NOW.toISOString());
  assert.equal(row.expires_at.toISOString(), '2026-07-30T01:00:00.000Z');

  assert.throws(
    () => assertStagedUploadQuota({
      currentCount: 25,
      currentBytes: 0,
      incomingCount: 1,
      incomingBytes: 1,
      maxCount: 25,
      maxBytes: 100,
    }),
    { code: 'ATTACHMENT_STAGED_QUOTA_EXCEEDED' },
  );
  assert.throws(
    () => assertStagedUploadQuota({
      currentCount: 1,
      currentBytes: 100,
      incomingCount: 1,
      incomingBytes: 1,
      maxCount: 25,
      maxBytes: 100,
    }),
    { code: 'ATTACHMENT_STAGED_QUOTA_EXCEEDED' },
  );
});

test('owned staged deletion is idempotent and rejects unsafe lifecycle states', async (t) => {
  await t.test('owned staged attachment is removed from MinIO and PostgreSQL', async () => {
    const infrastructure = createMemoryInfrastructure([{
      id: ATTACHMENT_ID,
      conversation_id: CONVERSATION_ID,
      uploader_id: USER_ID,
      status: 'staged',
    }]);
    const lifecycle = createTestLifecycle(infrastructure);

    assert.deepEqual(await lifecycle.deleteStagedAttachment({
      attachmentId: ATTACHMENT_ID,
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
    }), { deleted: true });
    assert.equal(infrastructure.rows.has(ATTACHMENT_ID), false);
    assert.equal(infrastructure.objects.size, 0);
    assert.deepEqual(await lifecycle.deleteStagedAttachment({
      attachmentId: ATTACHMENT_ID,
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
    }), { deleted: false, reason: 'not_found' });
  });

  for (const scenario of [
    { name: 'foreign user', status: 'staged', userId: OTHER_USER_ID, code: 'ATTACHMENT_FORBIDDEN' },
    { name: 'wrong conversation', status: 'staged', conversationId: OTHER_CONVERSATION_ID, code: 'ATTACHMENT_NOT_FOUND' },
    { name: 'reserved', status: 'reserved', code: 'ATTACHMENT_NOT_STAGED' },
    { name: 'committed', status: 'committed', code: 'ATTACHMENT_NOT_STAGED' },
    { name: 'legacy', status: 'legacy', code: 'ATTACHMENT_NOT_STAGED' },
  ]) {
    await t.test(`rejects ${scenario.name}`, async () => {
      const infrastructure = createMemoryInfrastructure([{
        id: ATTACHMENT_ID,
        conversation_id: CONVERSATION_ID,
        uploader_id: USER_ID,
        status: scenario.status,
      }]);
      const lifecycle = createTestLifecycle(infrastructure);
      await assert.rejects(
        lifecycle.deleteStagedAttachment({
          attachmentId: ATTACHMENT_ID,
          userId: scenario.userId || USER_ID,
          conversationId: scenario.conversationId || CONVERSATION_ID,
        }),
        { code: scenario.code },
      );
      assert.equal(infrastructure.rows.has(ATTACHMENT_ID), true);
      assert.equal(infrastructure.objects.size, 1);
    });
  }
});

test('message reservation validates ownership, expiry, presence, and committed reuse', async (t) => {
  const baseRow = {
    id: ATTACHMENT_ID,
    conversation_id: CONVERSATION_ID,
    uploader_id: USER_ID,
    status: 'staged',
  };

  for (const scenario of [
    {
      name: 'missing attachment',
      rows: [],
      code: 'ATTACHMENT_NOT_FOUND',
    },
    {
      name: 'foreign uploader',
      rows: [{ ...baseRow, uploader_id: OTHER_USER_ID }],
      code: 'ATTACHMENT_FORBIDDEN',
    },
    {
      name: 'wrong conversation',
      rows: [{ ...baseRow, conversation_id: OTHER_CONVERSATION_ID }],
      code: 'ATTACHMENT_FORBIDDEN',
    },
    {
      name: 'expired staged attachment',
      rows: [{ ...baseRow, expires_at: new Date(NOW.getTime() - 1000) }],
      code: 'ATTACHMENT_EXPIRED',
    },
    {
      name: 'committed by another operation',
      rows: [{
        ...baseRow,
        status: 'committed',
        reservation_id: 'other-operation',
        message_id: SECOND_MESSAGE_ID,
      }],
      code: 'ATTACHMENT_ALREADY_USED',
    },
  ]) {
    await t.test(`rejects ${scenario.name}`, async () => {
      const infrastructure = createMemoryInfrastructure(scenario.rows);
      const lifecycle = createTestLifecycle(infrastructure);
      await assert.rejects(
        lifecycle.reserveForMessage({
          attachmentIds: [ATTACHMENT_ID],
          userId: USER_ID,
          conversationId: CONVERSATION_ID,
          reservationId: 'client-message-1',
          messageId: MESSAGE_ID,
        }),
        { code: scenario.code },
      );
    });
  }
});

test('reservation is exclusive, commits once, and supports exact idempotent recovery', async () => {
  const infrastructure = createMemoryInfrastructure([
    {
      id: ATTACHMENT_ID,
      conversation_id: CONVERSATION_ID,
      uploader_id: USER_ID,
      status: 'staged',
    },
    {
      id: SECOND_ATTACHMENT_ID,
      conversation_id: CONVERSATION_ID,
      uploader_id: USER_ID,
      status: 'staged',
    },
  ]);
  const lifecycle = createTestLifecycle(infrastructure);

  const first = await lifecycle.reserveForMessage({
    attachmentIds: [ATTACHMENT_ID],
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    reservationId: 'client-message-1',
    messageId: MESSAGE_ID,
  });
  assert.equal(first.state, 'reserved_new');

  const concurrentSameOperation = await lifecycle.reserveForMessage({
    attachmentIds: [ATTACHMENT_ID],
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    reservationId: 'client-message-1',
    messageId: SECOND_MESSAGE_ID,
  });
  assert.equal(concurrentSameOperation.state, 'reserved');
  assert.equal(concurrentSameOperation.messageId, MESSAGE_ID);

  await assert.rejects(
    lifecycle.reserveForMessage({
      attachmentIds: [ATTACHMENT_ID],
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      reservationId: 'client-message-2',
      messageId: SECOND_MESSAGE_ID,
    }),
    { code: 'ATTACHMENT_ALREADY_USED' },
  );
  await assert.rejects(
    lifecycle.reserveForMessage({
      attachmentIds: [SECOND_ATTACHMENT_ID],
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      reservationId: 'client-message-1',
      messageId: SECOND_MESSAGE_ID,
    }),
    { code: 'CLIENT_MESSAGE_ATTACHMENT_MISMATCH' },
  );

  await lifecycle.commitReservation(infrastructure.dbPool, first);
  assert.equal(infrastructure.rows.get(ATTACHMENT_ID).status, 'committed');
  assert.equal(infrastructure.rows.get(ATTACHMENT_ID).message_id, MESSAGE_ID);

  const recovered = await lifecycle.reserveForMessage({
    attachmentIds: [ATTACHMENT_ID],
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    reservationId: 'client-message-1',
    messageId: SECOND_MESSAGE_ID,
  });
  assert.equal(recovered.state, 'committed');
  assert.equal(recovered.messageId, MESSAGE_ID);
});

test('confirmed message persistence failure releases its owned reservation safely', async () => {
  const infrastructure = createMemoryInfrastructure([{
    id: ATTACHMENT_ID,
    conversation_id: CONVERSATION_ID,
    uploader_id: USER_ID,
    status: 'staged',
  }]);
  const lifecycle = createTestLifecycle(infrastructure);
  const reservation = await lifecycle.reserveForMessage({
    attachmentIds: [ATTACHMENT_ID],
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    reservationId: 'client-message-1',
    messageId: MESSAGE_ID,
  });

  assert.equal(await lifecycle.releaseReservation(reservation), 1);
  const row = infrastructure.rows.get(ATTACHMENT_ID);
  assert.equal(row.status, 'staged');
  assert.equal(row.reservation_id, null);
  assert.equal(row.message_id, null);
});

test('cleanup removes only expired staged objects and preserves tracking on MinIO failure', async () => {
  const expiredId = ATTACHMENT_ID;
  const failedId = SECOND_ATTACHMENT_ID;
  const committedId = '99999999-9999-4999-8999-999999999999';
  const legacyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const infrastructure = createMemoryInfrastructure([
    {
      id: expiredId,
      conversation_id: CONVERSATION_ID,
      uploader_id: USER_ID,
      status: 'staged',
      expires_at: new Date(NOW.getTime() - 2000),
    },
    {
      id: failedId,
      conversation_id: CONVERSATION_ID,
      uploader_id: USER_ID,
      status: 'staged',
      expires_at: new Date(NOW.getTime() - 1000),
    },
    {
      id: committedId,
      conversation_id: CONVERSATION_ID,
      uploader_id: USER_ID,
      status: 'committed',
      expires_at: new Date(NOW.getTime() - 5000),
    },
    {
      id: legacyId,
      conversation_id: CONVERSATION_ID,
      uploader_id: USER_ID,
      status: 'legacy',
      expires_at: new Date(NOW.getTime() - 5000),
    },
  ]);
  infrastructure.failedObjectDeletes.add(
    infrastructure.rows.get(failedId).object_key,
  );
  const lifecycle = createTestLifecycle(infrastructure);

  const result = await lifecycle.cleanupExpiredStaged();
  assert.deepEqual(result, { selected: 2, deleted: 1, failed: 1 });
  assert.equal(infrastructure.rows.has(expiredId), false);
  assert.equal(infrastructure.rows.has(failedId), true);
  assert.equal(infrastructure.rows.has(committedId), true);
  assert.equal(infrastructure.rows.has(legacyId), true);
});

test('cleanup runner coalesces local calls and honors the distributed lease', async () => {
  let cleanupCalls = 0;
  let releaseCalls = 0;
  const lifecycle = {
    config: { cleanupIntervalSeconds: 900 },
    async cleanupExpiredStaged() {
      cleanupCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { selected: 1, deleted: 1, failed: 0 };
    },
  };
  const lockClient = {
    async set() {
      return 'OK';
    },
    async eval() {
      releaseCalls += 1;
      return 1;
    },
  };
  const runner = createStagedAttachmentCleanupRunner({
    lifecycle,
    lockClient,
    logger: { error() {}, warn() {} },
  });

  const [first, second] = await Promise.all([runner.runOnce(), runner.runOnce()]);
  assert.deepEqual(first, { selected: 1, deleted: 1, failed: 0 });
  assert.deepEqual(second, first);
  assert.equal(cleanupCalls, 1);
  assert.equal(releaseCalls, 1);

  const blockedRunner = createStagedAttachmentCleanupRunner({
    lifecycle,
    lockClient: {
      async set() {
        return null;
      },
      async eval() {
        throw new Error('lock was not acquired');
      },
    },
    logger: { error() {}, warn() {} },
  });
  assert.deepEqual(
    await blockedRunner.runOnce(),
    { skipped: true, reason: 'lock_held' },
  );
  assert.equal(cleanupCalls, 1);
});

test('migration conservatively marks historical rows legacy and cleanup targets staged only', async () => {
  const migration = await readFile(
    new URL('../../../db/migrations/0007_attachment_lifecycle.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /SET status = 'legacy'\s+WHERE status IS NULL/i);
  assert.match(migration, /WHERE status = 'staged'/i);
  assert.doesNotMatch(migration, /DELETE FROM attachment_objects/i);
});

test('lifecycle failures expose stable HTTP-safe error bodies', () => {
  try {
    extractProtectedAttachmentIds([descriptor(), descriptor()]);
    assert.fail('expected duplicate rejection');
  } catch (error) {
    assert.ok(error instanceof AttachmentLifecycleError);
    assert.equal(error.status, 400);
    assert.equal(error.body.code, 'ATTACHMENT_DUPLICATE');
  }
});
