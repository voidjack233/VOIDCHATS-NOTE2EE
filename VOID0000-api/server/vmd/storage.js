import { pool } from '../db.js';
import { ATTACH_BUCKET, minioClient } from '../minio.js';
import sentinel, { createSentinelKey } from '../sentinel/index.js';
import { transformVmdImage, VmdMediaError } from './imageVariants.js';

const DEFAULT_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_TRANSFORMS = 2;

function resolvePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_SOURCE_BYTES = resolvePositiveInteger(
  process.env.VMD_MAX_SOURCE_BYTES,
  DEFAULT_MAX_SOURCE_BYTES,
);
const MAX_CONCURRENT_TRANSFORMS = resolvePositiveInteger(
  process.env.VMD_MAX_CONCURRENT_TRANSFORMS,
  DEFAULT_MAX_CONCURRENT_TRANSFORMS,
);

let activeTransforms = 0;

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
  if (activeTransforms >= MAX_CONCURRENT_TRANSFORMS) {
    throw new VmdMediaError('VMD is temporarily at capacity', {
      code: 'VMD_AT_CAPACITY',
      status: 503,
    });
  }

  activeTransforms += 1;
  try {
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

    const source = await readObjectBuffer(attachment.object_key, objectStat.size);
    return transformVmdImage(source, variant);
  } finally {
    activeTransforms -= 1;
  }
}

export function renderStoredVmdImage(attachmentId, variant) {
  const flightKey = createSentinelKey('vmd.image-variant', attachmentId, variant);
  return sentinel.guard(
    flightKey,
    () => renderStoredImage(attachmentId, variant),
  );
}
