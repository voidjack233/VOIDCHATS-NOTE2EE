import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import {
  getStoredAttachmentSanitizerMarker,
  resolveStoredAttachmentPolicy,
} from '../../../server/utils/attachmentContentPolicy.js';
import {
  processLegacyImageCandidate,
  runLegacyImageMigration,
} from '../../attachments/legacyImageMigrationCore.js';
import {
  ChatImageSanitizationError,
  sanitizeChatAttachmentImage,
} from '../../../server/utils/chatImageSanitizer.js';
import {
  createDescriptorUpdater,
  parseLegacyImageMigrationArgs,
  readApprovedAttachmentIds,
} from '../../attachments/resanitizeLegacyImages.js';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

function createAttachmentId(index) {
  return `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
}

function createRow(index = 1) {
  const id = createAttachmentId(index);
  return {
    id,
    conversation_id: CONVERSATION_ID,
    uploader_id: '33333333-3333-4333-8333-333333333333',
    bucket: 'chat-attachments',
    object_key: `${CONVERSATION_ID}/${id}.bin`,
  };
}

function createReference(row, descriptorOverrides = {}) {
  const descriptor = {
    url: `/api/conversations/${CONVERSATION_ID}/attachments/${row.id}`,
    mime: 'image/jpeg',
    name: 'legacy.jpg',
    width: 24,
    height: 16,
    ...descriptorOverrides,
  };
  return {
    descriptor,
    index: 0,
    messageRecord: {
      storageConversationId: CONVERSATION_ID,
      messageId: '6b3ba5a0-4d75-11f1-8000-000000000001',
      attachments: [JSON.stringify(descriptor)],
    },
  };
}

function normalizeMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(metadata || {}).map(([name, value]) => [
      name.toLowerCase(),
      String(value),
    ]),
  );
}

class FakeObjectStore {
  constructor(row, source, metadata = { 'Content-Type': 'image/jpeg' }) {
    this.objects = new Map([[
      row.object_key,
      {
        buffer: Buffer.from(source),
        metadata: normalizeMetadata(metadata),
        etag: 'etag-original',
      },
    ]]);
    this.putCalls = 0;
    this.copyCalls = 0;
    this.removeCalls = 0;
    this.readCalls = 0;
    this.failReplacementCopy = false;
    this.failRestoreCopy = false;
    this.corruptReplacementVerification = false;
    this.etagSequence = 0;
  }

  snapshot(objectKey) {
    const entry = this.objects.get(objectKey);
    return entry ? {
      buffer: Buffer.from(entry.buffer),
      metadata: { ...entry.metadata },
      etag: entry.etag,
    } : null;
  }

  async statObject(objectKey) {
    const entry = this.objects.get(objectKey);
    if (!entry) {
      const error = new Error('Object missing');
      error.code = 'NoSuchKey';
      throw error;
    }
    const metadata = this.corruptReplacementVerification &&
      !objectKey.startsWith('.void-legacy-resanitize/') &&
      getStoredAttachmentSanitizerMarker({ metaData: entry.metadata }) === '1'
      ? { ...entry.metadata, 'x-amz-meta-void-sanitized-image': '0' }
      : entry.metadata;
    return {
      size: entry.buffer.length,
      etag: entry.etag,
      metaData: { ...metadata },
    };
  }

  async readObject(objectKey, maxBytes) {
    this.readCalls += 1;
    const entry = this.objects.get(objectKey);
    if (!entry) {
      const error = new Error('Object missing');
      error.code = 'NoSuchKey';
      throw error;
    }
    if (entry.buffer.length > maxBytes) {
      const error = new Error('Object too large');
      error.code = 'ATTACHMENT_TOO_LARGE';
      throw error;
    }
    return Buffer.from(entry.buffer);
  }

  async putObject(objectKey, buffer, metadata) {
    this.putCalls += 1;
    this.etagSequence += 1;
    this.objects.set(objectKey, {
      buffer: Buffer.from(buffer),
      metadata: normalizeMetadata(metadata),
      etag: `etag-put-${this.etagSequence}`,
    });
  }

  async copyObject(sourceObjectKey, destinationObjectKey, { matchEtag } = {}) {
    this.copyCalls += 1;
    const source = this.objects.get(sourceObjectKey);
    if (!source) {
      const error = new Error('Copy source missing');
      error.code = 'NoSuchKey';
      throw error;
    }
    if (matchEtag && source.etag !== matchEtag) {
      const error = new Error('ETag mismatch');
      error.code = 'PreconditionFailed';
      throw error;
    }
    if (
      this.failReplacementCopy &&
      sourceObjectKey.endsWith('.sanitized') &&
      !destinationObjectKey.startsWith('.void-legacy-resanitize/')
    ) {
      throw new Error('Injected replacement failure');
    }
    if (
      this.failRestoreCopy &&
      sourceObjectKey.endsWith('.backup') &&
      !destinationObjectKey.startsWith('.void-legacy-resanitize/')
    ) {
      throw new Error('Injected restoration failure');
    }
    this.objects.set(destinationObjectKey, {
      buffer: Buffer.from(source.buffer),
      metadata: { ...source.metadata },
      etag: source.etag,
    });
  }

  async removeObject(objectKey) {
    this.removeCalls += 1;
    this.objects.delete(objectKey);
  }
}

async function createJpeg({
  width = 24,
  height = 16,
  orientation,
} = {}) {
  let pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#167d6b',
    },
  }).jpeg({ quality: 92 });
  if (orientation) {
    pipeline = pipeline.withMetadata({ orientation });
  }
  return pipeline.toBuffer();
}

function createDependencies({
  row,
  source,
  descriptorOverrides,
  metadata,
  sanitizeImage = sanitizeChatAttachmentImage,
  objectStore = new FakeObjectStore(row, source, metadata),
  verifyDelivery,
} = {}) {
  const reference = createReference(row, descriptorOverrides);
  let descriptorUpdateCalls = 0;
  let sanitizedCalls = 0;

  return {
    reference,
    objectStore,
    get descriptorUpdateCalls() {
      return descriptorUpdateCalls;
    },
    get sanitizedCalls() {
      return sanitizedCalls;
    },
    dependencies: {
      async findDescriptorReferences() {
        return [reference];
      },
      objectStore,
      async sanitizeImage(buffer, claimedMime) {
        sanitizedCalls += 1;
        return sanitizeImage(buffer, claimedMime);
      },
      async updateDescriptorDimensions(_candidate, references, width, height) {
        descriptorUpdateCalls += 1;
        references.forEach((entry) => {
          entry.descriptor.width = width;
          entry.descriptor.height = height;
        });
        return { updatedCount: references.length };
      },
      async verifyDelivery(candidate, resolvedReference) {
        if (verifyDelivery) {
          await verifyDelivery(candidate, resolvedReference, objectStore);
          return;
        }
        const stat = await objectStore.statObject(candidate.object_key);
        assert.equal(resolveStoredAttachmentPolicy(stat, candidate.object_key).inline, true);
      },
    },
  };
}

test('dry-run identifies a valid unmarked JPEG without MinIO or descriptor mutation', async () => {
  const row = createRow();
  const source = await createJpeg();
  const setup = createDependencies({ row, source });
  const original = setup.objectStore.snapshot(row.object_key);

  const report = await processLegacyImageCandidate(row, {
    apply: false,
    dependencies: setup.dependencies,
  });

  assert.equal(report.status, 'dry_run_candidate');
  assert.equal(report.marker_before, null);
  assert.equal(report.new_content_type, 'image/jpeg');
  assert.equal(setup.sanitizedCalls, 1);
  assert.equal(setup.objectStore.putCalls, 0);
  assert.equal(setup.objectStore.copyCalls, 0);
  assert.equal(setup.descriptorUpdateCalls, 0);
  assert.deepEqual(setup.objectStore.snapshot(row.object_key), original);
});

test('valid legacy raster is sanitized, replaced, marked, and becomes inline eligible', async () => {
  const row = createRow();
  const source = await createJpeg();
  const setup = createDependencies({
    row,
    source,
    verifyDelivery: async (candidate, _reference, objectStore) => {
      const stat = await objectStore.statObject(candidate.object_key);
      assert.equal(resolveStoredAttachmentPolicy(stat, candidate.object_key).inline, true);
    },
  });

  const report = await processLegacyImageCandidate(row, {
    apply: true,
    dependencies: setup.dependencies,
  });
  const stored = await setup.objectStore.statObject(row.object_key);

  assert.equal(report.status, 'migrated');
  assert.equal(report.marker_after, '1');
  assert.equal(getStoredAttachmentSanitizerMarker(stored), '1');
  assert.equal(resolveStoredAttachmentPolicy(stored, row.object_key).inline, true);
  assert.ok(setup.objectStore.snapshot(row.object_key).buffer.length > 0);
});

test('already trusted object is skipped without download or rewrite', async () => {
  const row = createRow();
  const source = await createJpeg();
  const setup = createDependencies({
    row,
    source,
    metadata: {
      'Content-Type': 'image/jpeg',
      'X-Amz-Meta-Void-Sanitized-Image': '1',
    },
  });

  const report = await processLegacyImageCandidate(row, {
    apply: true,
    dependencies: setup.dependencies,
  });

  assert.equal(report.status, 'already_trusted');
  assert.equal(setup.objectStore.readCalls, 0);
  assert.equal(setup.objectStore.putCalls, 0);
  assert.equal(setup.objectStore.copyCalls, 0);
});

test('fake image descriptor with HTML bytes is rejected without mutation', async () => {
  const row = createRow();
  const source = Buffer.from('<!doctype html><script>alert(1)</script>');
  const setup = createDependencies({ row, source });
  const original = setup.objectStore.snapshot(row.object_key);

  const report = await processLegacyImageCandidate(row, {
    apply: true,
    dependencies: setup.dependencies,
  });

  assert.equal(report.status, 'corrupt');
  assert.deepEqual(setup.objectStore.snapshot(row.object_key), original);
  assert.equal(setup.objectStore.putCalls, 0);
});

test('SVG remains unsupported and untrusted', async () => {
  const row = createRow();
  const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
  const setup = createDependencies({
    row,
    source,
    descriptorOverrides: {
      mime: 'image/svg+xml',
      name: 'active.svg',
    },
  });

  const report = await processLegacyImageCandidate(row, {
    apply: true,
    dependencies: setup.dependencies,
  });
  const stat = await setup.objectStore.statObject(row.object_key);

  assert.equal(report.status, 'unsupported');
  assert.notEqual(getStoredAttachmentSanitizerMarker(stat), '1');
});

test('corrupt image remains unchanged and receives a corrupt report', async () => {
  const row = createRow();
  const source = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
  const setup = createDependencies({ row, source });
  const original = setup.objectStore.snapshot(row.object_key);

  const report = await processLegacyImageCandidate(row, {
    apply: true,
    dependencies: setup.dependencies,
  });

  assert.equal(report.status, 'corrupt');
  assert.deepEqual(setup.objectStore.snapshot(row.object_key), original);
});

test('ordinary non-image selected by dimensions remains unchanged and untrusted', async () => {
  const row = createRow();
  const source = Buffer.from('ordinary text attachment');
  const setup = createDependencies({
    row,
    source,
    descriptorOverrides: {
      mime: 'text/plain',
      name: 'notes.txt',
      width: 40,
      height: 20,
    },
  });
  const original = setup.objectStore.snapshot(row.object_key);

  const report = await processLegacyImageCandidate(row, {
    apply: true,
    dependencies: setup.dependencies,
  });

  assert.equal(report.status, 'skipped_non_image');
  assert.deepEqual(setup.objectStore.snapshot(row.object_key), original);
});

test('sanitizer transport failure leaves the original object intact', async () => {
  const row = createRow();
  const source = await createJpeg();
  const error = new Error('Worker unavailable');
  error.code = 'ATTACHMENT_SANITIZER_UNAVAILABLE';
  const setup = createDependencies({
    row,
    source,
    sanitizeImage: async () => {
      throw error;
    },
  });
  const original = setup.objectStore.snapshot(row.object_key);

  const report = await processLegacyImageCandidate(row, {
    apply: true,
    dependencies: setup.dependencies,
  });

  assert.equal(report.status, 'sanitizer_unavailable');
  assert.deepEqual(setup.objectStore.snapshot(row.object_key), original);
});

test('MinIO replacement failure does not update descriptors or alter the original', async () => {
  const row = createRow();
  const source = await createJpeg();
  const objectStore = new FakeObjectStore(row, source);
  objectStore.failReplacementCopy = true;
  const setup = createDependencies({ row, source, objectStore });
  const original = setup.objectStore.snapshot(row.object_key);

  const report = await processLegacyImageCandidate(row, {
    apply: true,
    dependencies: setup.dependencies,
  });

  assert.equal(report.status, 'failed');
  assert.equal(setup.descriptorUpdateCalls, 0);
  assert.deepEqual(setup.objectStore.snapshot(row.object_key), original);
});

test('post-copy verification failure restores the original and is not reported migrated', async () => {
  const row = createRow();
  const source = await createJpeg();
  const objectStore = new FakeObjectStore(row, source);
  objectStore.corruptReplacementVerification = true;
  const setup = createDependencies({ row, source, objectStore });
  const original = setup.objectStore.snapshot(row.object_key);

  const report = await processLegacyImageCandidate(row, {
    apply: true,
    dependencies: setup.dependencies,
  });

  assert.equal(report.status, 'failed');
  assert.equal(setup.descriptorUpdateCalls, 0);
  assert.deepEqual(setup.objectStore.snapshot(row.object_key).buffer, original.buffer);
  assert.notEqual(
    getStoredAttachmentSanitizerMarker(
      await setup.objectStore.statObject(row.object_key),
    ),
    '1',
  );
});

test('uncertain restoration failure is reported and stops later candidates', async () => {
  const firstRow = createRow(1);
  const secondRow = createRow(2);
  const source = await createJpeg();
  const objectStore = new FakeObjectStore(firstRow, source);
  objectStore.corruptReplacementVerification = true;
  objectStore.failRestoreCopy = true;
  let resolvedRows = 0;
  const records = [];

  await assert.rejects(
    runLegacyImageMigration([firstRow, secondRow], {
      apply: true,
      dependencies: {
        async findDescriptorReferences(row) {
          resolvedRows += 1;
          return [createReference(row)];
        },
        objectStore,
        sanitizeImage: sanitizeChatAttachmentImage,
        async updateDescriptorDimensions() {
          return { updatedCount: 0 };
        },
      },
      onRecord(record) {
        records.push(record);
      },
    }),
    { code: 'LEGACY_IMAGE_RESTORE_FAILED' },
  );

  assert.equal(resolvedRows, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'failed');
  assert.equal(records[0].restoration_attempted, true);
  assert.equal(records[0].restoration_succeeded, false);
  assert.equal(records[0].error_code, 'LEGACY_IMAGE_RESTORE_FAILED');
});

test('EXIF rotation produces corrected dimensions through a targeted update', async () => {
  const row = createRow();
  const source = await createJpeg({
    width: 20,
    height: 30,
    orientation: 6,
  });
  const setup = createDependencies({
    row,
    source,
    descriptorOverrides: {
      width: 20,
      height: 30,
    },
  });

  const report = await processLegacyImageCandidate(row, {
    apply: true,
    dependencies: setup.dependencies,
  });

  assert.equal(report.status, 'migrated');
  assert.equal(report.width, 30);
  assert.equal(report.height, 20);
  assert.equal(report.descriptor_updates, 1);
  assert.equal(setup.reference.descriptor.width, 30);
  assert.equal(setup.reference.descriptor.height, 20);
});

test('idempotent rerun skips a successfully migrated object', async () => {
  const row = createRow();
  const source = await createJpeg();
  const setup = createDependencies({ row, source });

  const first = await processLegacyImageCandidate(row, {
    apply: true,
    dependencies: setup.dependencies,
  });
  const readsAfterFirst = setup.objectStore.readCalls;
  const second = await processLegacyImageCandidate(row, {
    apply: true,
    dependencies: setup.dependencies,
  });

  assert.equal(first.status, 'migrated');
  assert.equal(second.status, 'already_trusted');
  assert.equal(setup.objectStore.readCalls, readsAfterFirst);
});

test('migration processes candidates with maximum concurrency one', async () => {
  const rows = [createRow(1), createRow(2), createRow(3), createRow(4)];
  const source = await createJpeg();
  const stores = new Map(
    rows.map((row) => [row.object_key, new FakeObjectStore(row, source)]),
  );
  let activeSanitizers = 0;
  let maximumActiveSanitizers = 0;

  const reports = await runLegacyImageMigration(rows, {
    apply: false,
    dependencies: {
      async findDescriptorReferences(row) {
        return [createReference(row)];
      },
      objectStore: {
        statObject(objectKey) {
          return stores.get(objectKey).statObject(objectKey);
        },
        readObject(objectKey, maxBytes) {
          return stores.get(objectKey).readObject(objectKey, maxBytes);
        },
      },
      async sanitizeImage(buffer, claimedMime) {
        activeSanitizers += 1;
        maximumActiveSanitizers = Math.max(
          maximumActiveSanitizers,
          activeSanitizers,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = await sanitizeChatAttachmentImage(buffer, claimedMime);
        activeSanitizers -= 1;
        return result;
      },
    },
  });

  assert.equal(reports.length, rows.length);
  assert.ok(reports.every((report) => report.status === 'dry_run_candidate'));
  assert.equal(maximumActiveSanitizers, 1);
});

test('active-content metadata forgery cannot become inline', () => {
  for (const contentType of ['text/html', 'application/javascript', 'image/svg+xml']) {
    const policy = resolveStoredAttachmentPolicy({
      metaData: {
        'content-type': contentType,
        'x-amz-meta-void-sanitized-image': '1',
      },
    }, 'forged-object.bin');
    assert.equal(policy.inline, false);
  }
});

test('sanitizer errors retain their bounded migration classification', async () => {
  const row = createRow();
  const source = await createJpeg();
  const setup = createDependencies({
    row,
    source,
    sanitizeImage: async () => {
      throw new ChatImageSanitizationError('Too many pixels', {
        code: 'ATTACHMENT_IMAGE_LIMIT_EXCEEDED',
        status: 413,
      });
    },
  });

  const report = await processLegacyImageCandidate(row, {
    apply: false,
    dependencies: setup.dependencies,
  });
  assert.equal(report.status, 'exceeds_limits');
});

test('operator CLI defaults to dry-run and validates bounded filters', () => {
  const defaults = parseLegacyImageMigrationArgs([]);
  assert.equal(defaults.apply, false);
  assert.equal(defaults.limit, 1_000);
  assert.match(defaults.reportPath, /legacy-images-/);

  const explicit = parseLegacyImageMigrationArgs([
    '--apply',
    '--limit',
    '22',
    '--attachment-id',
    createAttachmentId(1),
    '--conversation-id',
    CONVERSATION_ID,
    '--resume-from',
    createAttachmentId(2),
    '--report',
    './migration-report.jsonl',
  ]);
  assert.equal(explicit.apply, true);
  assert.equal(explicit.limit, 22);
  assert.equal(explicit.attachmentId, createAttachmentId(1));
  assert.equal(explicit.conversationId, CONVERSATION_ID);
  assert.equal(explicit.resumeFrom, createAttachmentId(2));
  assert.ok(path.isAbsolute(explicit.reportPath));

  assert.throws(
    () => parseLegacyImageMigrationArgs(['--dry-run', '--apply']),
    /cannot be used together/,
  );
  assert.throws(
    () => parseLegacyImageMigrationArgs(['--limit', '0']),
    /between 1 and 10000/,
  );
  assert.throws(
    () => parseLegacyImageMigrationArgs(['--attachment-id', 'not-a-uuid']),
    /must be a UUID/,
  );
  assert.throws(
    () => parseLegacyImageMigrationArgs([
      '--attachment-ids-file',
      './approved.txt',
      '--conversation-id',
      CONVERSATION_ID,
    ]),
    /cannot be combined/,
  );
});

test('operator attachment allowlist accepts unique UUIDs and rejects duplicates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'void-attachment-ids-'));
  const allowlistPath = path.join(directory, 'approved.txt');
  try {
    await writeFile(
      allowlistPath,
      `${createAttachmentId(2)}\n${createAttachmentId(1)}\n`,
      'utf8',
    );
    assert.deepEqual(
      await readApprovedAttachmentIds(allowlistPath),
      [createAttachmentId(2), createAttachmentId(1)],
    );

    await writeFile(
      allowlistPath,
      `${createAttachmentId(1)}\n${createAttachmentId(1)}\n`,
      'utf8',
    );
    await assert.rejects(
      readApprovedAttachmentIds(allowlistPath),
      /duplicate attachment UUIDs/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('dimension correction uses a targeted conditional Scylla update', async () => {
  const row = createRow();
  const reference = createReference(row, {
    width: 20,
    height: 30,
  });
  const calls = [];
  const scylla = {
    async execute(query, params, options) {
      calls.push({ method: 'execute', query, params, options });
      return { rows: [{ '[applied]': true }] };
    },
    async batch() {
      throw new Error('Single message update should not require a batch');
    },
  };
  const cassandra = {
    types: {
      Uuid: { fromString: (value) => `uuid:${value}` },
      TimeUuid: { fromString: (value) => `timeuuid:${value}` },
    },
  };
  const updateDimensions = createDescriptorUpdater({ scylla, cassandra });

  const result = await updateDimensions(row, [reference], 30, 20);

  assert.equal(result.updatedCount, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /IF attachments = \?/);
  assert.deepEqual(calls[0].options, { prepare: true });
  const updatedDescriptor = JSON.parse(reference.messageRecord.attachments[0]);
  assert.equal(updatedDescriptor.width, 30);
  assert.equal(updatedDescriptor.height, 20);
});

test('dimension correction refuses a concurrent descriptor change', async () => {
  const row = createRow();
  const reference = createReference(row, {
    width: 20,
    height: 30,
  });
  const updateDimensions = createDescriptorUpdater({
    scylla: {
      async execute() {
        return { rows: [{ '[applied]': false }] };
      },
    },
    cassandra: {
      types: {
        Uuid: { fromString: (value) => value },
        TimeUuid: { fromString: (value) => value },
      },
    },
  });

  await assert.rejects(
    updateDimensions(row, [reference], 30, 20),
    { code: 'LEGACY_IMAGE_DESCRIPTOR_CONFLICT' },
  );
});
