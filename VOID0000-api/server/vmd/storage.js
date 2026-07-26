import { pool } from '../db.js';
import { ATTACH_BUCKET, minioClient } from '../minio.js';
import sentinel, { createSentinelKey } from '../sentinel/index.js';
import { resolveStoredAttachmentPolicy } from '../utils/attachmentContentPolicy.js';
import { transformVmdImage, VmdMediaError } from './imageVariants.js';
import { getVmdMetricsSnapshot, incrementVmdMetric } from './metrics.js';
import {
  createVmdVariantIdentity,
  vmdPersistentCache,
} from './persistentCache.js';
import { VmdWorkQueue } from './workQueue.js';

const DEFAULT_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_TRANSFORMS = 2;
const DEFAULT_MAX_QUEUED_TRANSFORMS = 8;
const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 10_000;

function resolvePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const MAX_SOURCE_BYTES = resolvePositiveInteger(
  process.env.VMD_MAX_SOURCE_BYTES,
  DEFAULT_MAX_SOURCE_BYTES,
);
const MAX_CONCURRENT_TRANSFORMS = resolvePositiveInteger(
  process.env.VMD_MAX_CONCURRENT_TRANSFORMS,
  DEFAULT_MAX_CONCURRENT_TRANSFORMS,
);
const MAX_QUEUED_TRANSFORMS = resolveNonNegativeInteger(
  process.env.VMD_MAX_QUEUED_TRANSFORMS,
  DEFAULT_MAX_QUEUED_TRANSFORMS,
);
const QUEUE_WAIT_TIMEOUT_MS = resolvePositiveInteger(
  process.env.VMD_QUEUE_WAIT_TIMEOUT_MS,
  DEFAULT_QUEUE_WAIT_TIMEOUT_MS,
);
const transformQueue = new VmdWorkQueue({
  maxConcurrent: MAX_CONCURRENT_TRANSFORMS,
  maxQueued: MAX_QUEUED_TRANSFORMS,
  waitTimeoutMs: QUEUE_WAIT_TIMEOUT_MS,
});
const CACHE_WARNING_INTERVAL_MS = 60_000;
const lastCacheWarningAt = new Map();

function warnCacheFailure(kind, error) {
  const now = Date.now();
  const lastWarningAt = lastCacheWarningAt.get(kind) || 0;
  if (now - lastWarningAt < CACHE_WARNING_INTERVAL_MS) return;

  lastCacheWarningAt.set(kind, now);
  console.warn(`[VMD_CACHE] ${kind}`, {
    error: error instanceof Error ? error.message : String(error || ''),
  });
}

function isObjectNotFoundError(error) {
  const code = String(error?.code || error?.name || '');
  return code === 'NoSuchKey' || code === 'NoSuchObject' || code === 'NotFound';
}

async function findAttachmentObject(attachmentId) {
  const result = await pool.query(
    `SELECT object_key
     FROM attachment_objects
     WHERE id = $1
       AND bucket = $2
     LIMIT 1`,
    [attachmentId, ATTACH_BUCKET],
  );
  return result.rows[0] || null;
}

async function readObjectBuffer(objectKey, expectedSize) {
  if (Number.isFinite(expectedSize) && expectedSize > MAX_SOURCE_BYTES) {
    throw new VmdMediaError('Attachment exceeds the VMD source limit', {
      code: 'VMD_SOURCE_TOO_LARGE',
      status: 413,
    });
  }

  let stream;
  try {
    stream = await minioClient.getObject(ATTACH_BUCKET, objectKey);
  } catch (error) {
    if (isObjectNotFoundError(error)) {
      throw new VmdMediaError('Attachment not found', {
        code: 'VMD_ATTACHMENT_NOT_FOUND',
        status: 404,
      });
    }
    throw error;
  }

  const chunks = [];
  let totalBytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_SOURCE_BYTES) {
        stream.destroy();
        throw new VmdMediaError('Attachment exceeds the VMD source limit', {
          code: 'VMD_SOURCE_TOO_LARGE',
          status: 413,
        });
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof VmdMediaError) throw error;
    throw new VmdMediaError('Attachment storage read failed', {
      code: 'VMD_STORAGE_UNAVAILABLE',
      status: 502,
    });
  }

  return Buffer.concat(chunks, totalBytes);
}

async function renderStoredImage(attachmentId, variant) {
  const attachment = await findAttachmentObject(attachmentId);
  if (!attachment) {
    throw new VmdMediaError('Attachment not found', {
      code: 'VMD_ATTACHMENT_NOT_FOUND',
      status: 404,
    });
  }

  let objectStat;
  try {
    objectStat = await minioClient.statObject(ATTACH_BUCKET, attachment.object_key);
  } catch (error) {
    if (isObjectNotFoundError(error)) {
      throw new VmdMediaError('Attachment not found', {
        code: 'VMD_ATTACHMENT_NOT_FOUND',
        status: 404,
      });
    }
    throw new VmdMediaError('Attachment storage is unavailable', {
      code: 'VMD_STORAGE_UNAVAILABLE',
      status: 502,
    });
  }

  const sourcePolicy = resolveStoredAttachmentPolicy(objectStat, attachment.object_key);
  if (!sourcePolicy.inline) {
    throw new VmdMediaError('Attachment is not an approved sanitized image', {
      code: 'VMD_ATTACHMENT_NOT_SANITIZED',
      status: 415,
    });
  }

  const cacheIdentity = createVmdVariantIdentity({
    attachmentId,
    objectKey: attachment.object_key,
    objectStat,
    variant,
  });
  const cached = await vmdPersistentCache.read(cacheIdentity);

  if (cached.status === 'hit') {
    incrementVmdMetric('persistent_cache_hits');
    return cached.image;
  }

  incrementVmdMetric('persistent_cache_misses');
  if (cached.status === 'corrupt') {
    incrementVmdMetric('persistent_cache_corrupt');
  } else if (cached.status === 'unavailable') {
    incrementVmdMetric('persistent_cache_read_failures');
    warnCacheFailure('read unavailable; regenerating from source', cached.error);
  }

  let generated;
  try {
    generated = await transformQueue.run(async () => {
      const source = await readObjectBuffer(attachment.object_key, objectStat.size);
      const image = await transformVmdImage(source, variant);
      incrementVmdMetric('transforms_generated');
      return image;
    });
  } catch (error) {
    if (error?.code === 'VMD_AT_CAPACITY') {
      incrementVmdMetric('queue_full');
    } else if (error?.code === 'VMD_QUEUE_TIMEOUT') {
      incrementVmdMetric('queue_timeouts');
    }
    throw error;
  }

  try {
    generated.etag = await vmdPersistentCache.write(cacheIdentity, generated);
  } catch (error) {
    incrementVmdMetric('persistent_cache_write_failures');
    warnCacheFailure('write failed; serving generated response', error);
  }

  return generated;
}

export function renderStoredVmdImage(attachmentId, variant) {
  const flightKey = createSentinelKey('vmd.image-variant', attachmentId, variant);
  return sentinel.guard(
    flightKey,
    () => renderStoredImage(attachmentId, variant),
  );
}

export function getVmdStorageMetrics() {
  return {
    ...getVmdMetricsSnapshot(),
    work_queue: transformQueue.getSnapshot(),
  };
}
