import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ATTACHMENT_MESSAGE_WRITE_POLICY,
  createAttachmentMessageConsistency,
  writeAttachmentMessageWithAcknowledgement,
} from '../../../server/attachments/messageConsistency.js';

test('attachment message insert, recovery read, and rollback delete use LOCAL_QUORUM', async () => {
  const calls = [];
  const consistency = createAttachmentMessageConsistency({
    scyllaClient: {
      async execute(query, parameters, options) {
        calls.push({ query, parameters, options });
        return { rows: [] };
      },
    },
    cassandraDriver: {
      types: {
        consistencies: {
          localQuorum: 6,
        },
      },
    },
  });

  await consistency.insert('INSERT INTO messages ...', ['insert']);
  await consistency.read('SELECT * FROM messages ...', ['read']);
  await consistency.remove('DELETE FROM messages ...', ['delete']);

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.options, {
      prepare: true,
      consistency: 6,
    });
  }
});

test('Scylla acknowledgement is recorded only after a successful insert', async () => {
  const successfulOrder = [];
  const result = await writeAttachmentMessageWithAcknowledgement({
    async insertMessage() {
      successfulOrder.push('insert');
      return { applied: true };
    },
    onInsertSucceeded() {
      successfulOrder.push('insert-returned');
    },
    async acknowledgeReservation() {
      successfulOrder.push('acknowledge');
    },
  });
  assert.deepEqual(result, { applied: true });
  assert.deepEqual(successfulOrder, [
    'insert',
    'insert-returned',
    'acknowledge',
  ]);

  const failedOrder = [];
  await assert.rejects(
    writeAttachmentMessageWithAcknowledgement({
      async insertMessage() {
        failedOrder.push('insert');
        throw new Error('Scylla timeout');
      },
      onInsertSucceeded() {
        failedOrder.push('insert-returned');
      },
      async acknowledgeReservation() {
        failedOrder.push('acknowledge');
      },
    }),
    /Scylla timeout/,
  );
  assert.deepEqual(failedOrder, ['insert']);
});

test('acknowledgement failure is reported after the Scylla write is known to have returned', async () => {
  let insertReturned = false;
  await assert.rejects(
    writeAttachmentMessageWithAcknowledgement({
      async insertMessage() {},
      onInsertSucceeded() {
        insertReturned = true;
      },
      async acknowledgeReservation() {
        throw new Error('PostgreSQL acknowledgement unavailable');
      },
    }),
    /acknowledgement unavailable/,
  );
  assert.equal(insertReturned, true);
});

test('message send wires quorum consistency to attachment writes and recovery operations', async () => {
  const source = await readFile(
    new URL(
      '../../../server/routes/conversations/messages/sendMessage.js',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(
    source,
    /if \(attachmentIds\.length > 0\)[\s\S]+writeAttachmentMessageWithAcknowledgement/,
  );
  assert.match(source, /attachmentLifecycle\.acknowledgeScyllaWrite/);
  assert.match(source, /attachmentMessageConsistency\.read/);
  assert.match(source, /attachmentMessageConsistency\.remove/);
  assert.equal(ATTACHMENT_MESSAGE_WRITE_POLICY, 'local_quorum_v1');
});

test('write-policy migration leaves historical reservations unmarked', async () => {
  const migration = await readFile(
    new URL(
      '../../../db/migrations/0009_attachment_message_write_policy.sql',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS scylla_write_policy TEXT/i);
  assert.match(migration, /scylla_write_policy = 'local_quorum_v1'/i);
  assert.doesNotMatch(migration, /UPDATE attachment_objects/i);
});
