import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ATTACHMENT_BLOB_SCHEMA_MIGRATION,
  assertAttachmentBlobSchemaCompatible,
} from '../../../server/attachments/schemaCompatibility.js';

function createSchemaPool({
  hasBlobTable = true,
  hasRequiredBlobId = true,
  hasBlobForeignKey = true,
  migrationApplied = true,
  failure = null,
} = {}) {
  let calls = 0;
  return {
    async query(_sql, params = []) {
      calls += 1;
      if (failure) throw failure;
      if (params.length === 0) {
        return {
          rows: [{
            has_blob_table: hasBlobTable,
            has_required_blob_id: hasRequiredBlobId,
            has_blob_foreign_key: hasBlobForeignKey,
          }],
        };
      }
      assert.deepEqual(params, [ATTACHMENT_BLOB_SCHEMA_MIGRATION]);
      return { rows: [{ migration_applied: migrationApplied }] };
    },
    get calls() {
      return calls;
    },
  };
}

test('attachment services accept the complete blob-aware schema contract', async () => {
  const dbPool = createSchemaPool();
  const result = await assertAttachmentBlobSchemaCompatible({
    dbPool,
    serviceName: 'test-message-service',
  });

  assert.deepEqual(result, {
    compatible: true,
    migration: ATTACHMENT_BLOB_SCHEMA_MIGRATION,
  });
  assert.equal(dbPool.calls, 2);
});

test('attachment services fail closed for every incomplete schema state', async (t) => {
  for (const scenario of [
    { name: 'missing blob table', hasBlobTable: false },
    { name: 'nullable or missing blob ID', hasRequiredBlobId: false },
    { name: 'missing blob foreign key', hasBlobForeignKey: false },
    { name: 'missing migration record', migrationApplied: false },
  ]) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        assertAttachmentBlobSchemaCompatible({
          dbPool: createSchemaPool(scenario),
          serviceName: 'test-message-service',
        }),
        (error) => (
          error?.code === 'ATTACHMENT_SCHEMA_INCOMPATIBLE' &&
          /no-mixed-version boundary/i.test(error.message) &&
          /stop old message-service instances/i.test(error.message)
        ),
      );
    });
  }
});

test('schema verification errors prevent startup instead of assuming compatibility', async () => {
  await assert.rejects(
    assertAttachmentBlobSchemaCompatible({
      dbPool: createSchemaPool({ failure: new Error('database unavailable') }),
      serviceName: 'test-worker-service',
    }),
    (error) => (
      error?.code === 'ATTACHMENT_SCHEMA_INCOMPATIBLE' &&
      error?.cause?.message === 'database unavailable'
    ),
  );
});

test('message and worker entrypoints verify schema before accepting attachment work', async () => {
  const [messageEntrypoint, workerEntrypoint] = await Promise.all([
    readFile(
      new URL('../../../server/entrypoints/message-server.js', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../../../server/entrypoints/worker-server.js', import.meta.url),
      'utf8',
    ),
  ]);

  assert.ok(
    messageEntrypoint.indexOf('await assertAttachmentBlobSchemaCompatible') <
      messageEntrypoint.indexOf('initPublisher();'),
  );
  assert.ok(
    messageEntrypoint.indexOf('await assertAttachmentBlobSchemaCompatible') <
      messageEntrypoint.indexOf('httpServer.listen'),
  );
  assert.ok(
    workerEntrypoint.indexOf('await assertAttachmentBlobSchemaCompatible') <
      workerEntrypoint.indexOf('startAttachmentSanitizerServer()'),
  );
});
