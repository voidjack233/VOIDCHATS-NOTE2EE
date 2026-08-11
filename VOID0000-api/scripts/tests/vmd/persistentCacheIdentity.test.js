import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VMD_CACHE_VERSION,
  createVmdVariantIdentity,
} from '../../../server/vmd/persistentCache.js';

const BASE_OBJECT_STAT = {
  etag: 'source-etag',
  versionId: 'version-1',
  size: 1234,
  lastModified: new Date('2026-08-08T01:02:03.000Z'),
};

test('VMD persistent identity deduplicates by physical source, not attachment ID', () => {
  const first = createVmdVariantIdentity({
    objectKey: 'blobs/v1/sha256/aa/' + 'aa'.repeat(32),
    objectStat: BASE_OBJECT_STAT,
    variant: 'small',
  });
  const secondLogicalAttachment = createVmdVariantIdentity({
    objectKey: 'blobs/v1/sha256/aa/' + 'aa'.repeat(32),
    objectStat: BASE_OBJECT_STAT,
    variant: 'small',
  });

  assert.equal(VMD_CACHE_VERSION, 'v2');
  assert.equal(first.objectKey, secondLogicalAttachment.objectKey);
  assert.match(first.objectKey, /^variants\/v2\/[0-9a-f]{64}\/[0-9a-f]{64}\/small\.webp$/);
  assert.equal(Object.hasOwn(first, 'attachmentId'), false);
});

test('VMD persistent identity separates source, variant, and source fingerprint', () => {
  const base = createVmdVariantIdentity({
    objectKey: 'blobs/source-a',
    objectStat: BASE_OBJECT_STAT,
    variant: 'small',
  });
  const differentSource = createVmdVariantIdentity({
    objectKey: 'blobs/source-b',
    objectStat: BASE_OBJECT_STAT,
    variant: 'small',
  });
  const differentVariant = createVmdVariantIdentity({
    objectKey: 'blobs/source-a',
    objectStat: BASE_OBJECT_STAT,
    variant: 'medium',
  });
  const changedFingerprint = createVmdVariantIdentity({
    objectKey: 'blobs/source-a',
    objectStat: { ...BASE_OBJECT_STAT, etag: 'changed-etag' },
    variant: 'small',
  });

  assert.notEqual(base.objectKey, differentSource.objectKey);
  assert.notEqual(base.objectKey, differentVariant.objectKey);
  assert.notEqual(base.objectKey, changedFingerprint.objectKey);
});
