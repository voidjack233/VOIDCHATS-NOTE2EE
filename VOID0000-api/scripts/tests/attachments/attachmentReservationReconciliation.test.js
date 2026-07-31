import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createAttachmentReservationReconciler,
  createAttachmentReservationReconciliationRunner,
  createPostgresAttachmentReservationStore,
  createScyllaAttachmentMessageReader,
} from '../../../server/attachments/reservationReconciliation.js';
import {
  ATTACHMENT_MESSAGE_WRITE_POLICY,
} from '../../../server/attachments/messageConsistency.js';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const STORAGE_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-1444-8444-444444444444';
const ATTACHMENT_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_ATTACHMENT_ID = '66666666-6666-4666-8666-666666666666';

function createGroup() {
  return {
    conversationId: CONVERSATION_ID,
    uploaderId: USER_ID,
    reservationId: 'client-message-1',
    messageId: MESSAGE_ID,
    scyllaWritePolicy: ATTACHMENT_MESSAGE_WRITE_POLICY,
    attachmentIds: [ATTACHMENT_ID],
  };
}

function createStateHarness({ message, loadError, groupOverrides } = {}) {
  const group = {
    ...createGroup(),
    ...groupOverrides,
  };
  let state = 'reserved';
  let freshExpiryAssigned = false;
  const reconciler = createAttachmentReservationReconciler({
    batchSize: 25,
    logger: { warn() {} },
    async listExpiredReservationGroups(limit) {
      assert.equal(limit, 25);
      return state === 'reserved' ? [group] : [];
    },
    async loadStoredMessage() {
      if (loadError) throw loadError;
      return message;
    },
    async markCommitted() {
      if (state !== 'reserved') return false;
      state = 'committed';
      return true;
    },
    async releaseToStaged() {
      if (state !== 'reserved') return false;
      state = 'staged';
      freshExpiryAssigned = true;
      return true;
    },
  });

  return {
    reconciler,
    get state() {
      return state;
    },
    get freshExpiryAssigned() {
      return freshExpiryAssigned;
    },
  };
}

test('existing Scylla message with exact attachments commits the reservation', async () => {
  const harness = createStateHarness({
    message: {
      senderId: USER_ID,
      attachmentIds: [ATTACHMENT_ID],
    },
  });

  assert.deepEqual(await harness.reconciler.runOnce(), {
    selected: 1,
    committed: 1,
    released: 0,
    mismatched: 0,
    uncertain: 0,
    stale: 0,
  });
  assert.equal(harness.state, 'committed');
});

test('definitively missing Scylla message returns reservation to staged', async () => {
  const harness = createStateHarness({ message: null });

  assert.deepEqual(await harness.reconciler.runOnce(), {
    selected: 1,
    committed: 0,
    released: 1,
    mismatched: 0,
    uncertain: 0,
    stale: 0,
  });
  assert.equal(harness.state, 'staged');
  assert.equal(harness.freshExpiryAssigned, true);
});

test('historical reservation without quorum policy remains reserved after a negative read', async () => {
  const harness = createStateHarness({
    message: null,
    groupOverrides: { scyllaWritePolicy: null },
  });

  assert.deepEqual(await harness.reconciler.runOnce(), {
    selected: 1,
    committed: 0,
    released: 0,
    mismatched: 0,
    uncertain: 1,
    stale: 0,
  });
  assert.equal(harness.state, 'reserved');
  assert.equal(harness.freshExpiryAssigned, false);
});

test('Scylla failure leaves the reservation unchanged for retry', async () => {
  const harness = createStateHarness({
    loadError: new Error('Scylla unavailable'),
  });

  assert.deepEqual(await harness.reconciler.runOnce(), {
    selected: 1,
    committed: 0,
    released: 0,
    mismatched: 0,
    uncertain: 1,
    stale: 0,
  });
  assert.equal(harness.state, 'reserved');
});

test('mismatched message attachments or uploader remain reserved for investigation', async (t) => {
  await t.test('attachment mismatch', async () => {
    const harness = createStateHarness({
      message: {
        senderId: USER_ID,
        attachmentIds: [OTHER_ATTACHMENT_ID],
      },
    });
    const summary = await harness.reconciler.runOnce();
    assert.equal(summary.mismatched, 1);
    assert.equal(harness.state, 'reserved');
  });

  await t.test('uploader mismatch', async () => {
    const harness = createStateHarness({
      message: {
        senderId: '77777777-7777-4777-8777-777777777777',
        attachmentIds: [ATTACHMENT_ID],
      },
    });
    const summary = await harness.reconciler.runOnce();
    assert.equal(summary.mismatched, 1);
    assert.equal(harness.state, 'reserved');
  });
});

test('repeated reconciliation is idempotent after a successful transition', async () => {
  const harness = createStateHarness({
    message: {
      senderId: USER_ID,
      attachmentIds: [ATTACHMENT_ID],
    },
  });

  assert.equal((await harness.reconciler.runOnce()).committed, 1);
  assert.deepEqual(await harness.reconciler.runOnce(), {
    selected: 0,
    committed: 0,
    released: 0,
    mismatched: 0,
    uncertain: 0,
    stale: 0,
  });
  assert.equal(harness.state, 'committed');
});

test('Scylla reader resolves storage identity and uses LOCAL_QUORUM', async () => {
  let executeInput;
  const cassandraDriver = {
    types: {
      Uuid: {
        fromString(value) {
          return `uuid:${value}`;
        },
      },
      TimeUuid: {
        fromString(value) {
          return `timeuuid:${value}`;
        },
      },
      consistencies: {
        localQuorum: 6,
      },
    },
  };
  const loadStoredMessage = createScyllaAttachmentMessageReader({
    dbPool: {
      async query() {
        return {
          rows: [{
            id: CONVERSATION_ID,
            type: 'group',
          }],
        };
      },
    },
    scyllaClient: {
      async execute(query, parameters, options) {
        executeInput = { query, parameters, options };
        return {
          rows: [{
            sender_id: { toString: () => USER_ID },
            attachments: [
              `/api/conversations/public-id/attachments/${ATTACHMENT_ID}`,
            ],
          }],
        };
      },
    },
    cassandraDriver,
    async resolveStorageConversation() {
      return { id: STORAGE_CONVERSATION_ID };
    },
  });

  assert.deepEqual(await loadStoredMessage(createGroup()), {
    senderId: USER_ID,
    attachmentIds: [ATTACHMENT_ID],
  });
  assert.deepEqual(executeInput.parameters, [
    `uuid:${STORAGE_CONVERSATION_ID}`,
    `timeuuid:${MESSAGE_ID}`,
  ]);
  assert.equal(executeInput.options.consistency, 6);
});

test('malformed Scylla read results are treated as uncertain', async () => {
  const loadStoredMessage = createScyllaAttachmentMessageReader({
    dbPool: {
      async query() {
        return { rows: [{ id: CONVERSATION_ID, type: 'group' }] };
      },
    },
    scyllaClient: {
      async execute() {
        return {};
      },
    },
    cassandraDriver: {
      types: {
        Uuid: { fromString: (value) => value },
        TimeUuid: { fromString: (value) => value },
        consistencies: { localQuorum: 6 },
      },
    },
    async resolveStorageConversation() {
      return { id: STORAGE_CONVERSATION_ID };
    },
  });

  await assert.rejects(
    loadStoredMessage(createGroup()),
    /malformed Scylla result/,
  );
});

test('PostgreSQL release transition is exact and assigns a fresh expiry', async () => {
  const group = createGroup();
  const queries = [];
  const client = {
    async query(query, parameters) {
      queries.push({ query, parameters });
      if (/SELECT id[\s\S]+FOR UPDATE/i.test(query)) {
        return {
          rows: [{
            id: ATTACHMENT_ID,
            scylla_write_policy: ATTACHMENT_MESSAGE_WRITE_POLICY,
          }],
        };
      }
      if (/UPDATE attachment_objects/i.test(query)) {
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const store = createPostgresAttachmentReservationStore({
    dbPool: {
      async query() {
        return { rows: [] };
      },
      async connect() {
        return client;
      },
    },
    freshStagedTtlSeconds: 300,
  });

  assert.equal(await store.releaseToStaged(group), true);
  const update = queries.find(({ query }) => /UPDATE attachment_objects/i.test(query));
  assert.match(update.query, /SET status = 'staged'/i);
  assert.match(update.query, /expires_at = NOW\(\) \+ \(\$6 \* INTERVAL '1 second'\)/i);
  assert.match(update.query, /reservation_id = NULL/i);
  assert.equal(update.parameters[5], 300);
});

test('reconciliation runner coalesces calls and honors its distributed lease', async () => {
  let reconciliationCalls = 0;
  let releaseCalls = 0;
  const runner = createAttachmentReservationReconciliationRunner({
    reconciler: {
      async runOnce() {
        reconciliationCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { selected: 1, committed: 1 };
      },
    },
    lockClient: {
      async set() {
        return 'OK';
      },
      async eval() {
        releaseCalls += 1;
        return 1;
      },
    },
    intervalSeconds: 900,
    logger: { error() {}, warn() {} },
  });

  const [first, second] = await Promise.all([runner.runOnce(), runner.runOnce()]);
  assert.deepEqual(first, { selected: 1, committed: 1 });
  assert.deepEqual(second, first);
  assert.equal(reconciliationCalls, 1);
  assert.equal(releaseCalls, 1);

  const blocked = createAttachmentReservationReconciliationRunner({
    reconciler: { async runOnce() {} },
    lockClient: {
      async set() {
        return null;
      },
      async eval() {
        throw new Error('lock was not acquired');
      },
    },
    intervalSeconds: 900,
    logger: { error() {}, warn() {} },
  });
  assert.deepEqual(
    await blocked.runOnce(),
    { skipped: true, reason: 'lock_held' },
  );
});

test('reconciliation migration adds a reserved-only expiry index', async () => {
  const migration = await readFile(
    new URL(
      '../../../db/migrations/0008_attachment_reserved_reconciliation.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(migration, /reserved_until/i);
  assert.match(migration, /WHERE status = 'reserved'/i);
});
