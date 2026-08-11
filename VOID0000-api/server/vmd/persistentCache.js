import { createHash } from 'crypto';
import { minioClient } from '../minio.js';

export const VMD_CACHE_VERSION = 'v2';
export const VMD_CACHE_BUCKET = process.env.MINIO_VMD_CACHE_BUCKET || 'vmd-variants';

const DEFAULT_CACHE_RETENTION_DAYS = 30;
const DEFAULT_MAX_VARIANT_BYTES = 16 * 1024 * 1024;

function resolvePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const CACHE_RETENTION_DAYS = resolvePositiveInteger(
  process.env.VMD_CACHE_RETENTION_DAYS,
  DEFAULT_CACHE_RETENTION_DAYS,
);
const MAX_VARIANT_BYTES = resolvePositiveInteger(
  process.env.VMD_MAX_VARIANT_BYTES,
  DEFAULT_MAX_VARIANT_BYTES,
);

function isMissingObjectError(error) {
  const code = String(error?.code || error?.name || '');
  return code === 'NoSuchKey' || code === 'NoSuchObject' || code === 'NotFound';
}

function normalizeEtag(value) {
  return String(value || '').replace(/^"|"$/g, '').trim().toLowerCase();
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64Url(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function parsePositiveMetadata(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function readBoundedObject(client, bucket, objectKey, expectedSize) {
  if (!Number.isFinite(expectedSize) || expectedSize <= 0 || expectedSize > MAX_VARIANT_BYTES) {
    throw new Error('Cached VMD variant has an invalid size');
  }

  const stream = await client.getObject(bucket, objectKey);
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_VARIANT_BYTES) {
      stream.destroy();
      throw new Error('Cached VMD variant exceeds the configured size limit');
    }
    chunks.push(buffer);
  }

  if (totalBytes !== expectedSize) {
    throw new Error('Cached VMD variant size does not match object metadata');
  }

  return Buffer.concat(chunks, totalBytes);
}

export function createVmdVariantIdentity({ objectKey, objectStat, variant }) {
  if (typeof objectKey !== 'string' || objectKey.length === 0) {
    throw new TypeError('VMD cache identity requires a physical object key');
  }
  const sourceDescriptor = JSON.stringify({
    object_key: String(objectKey),
    etag: normalizeEtag(objectStat?.etag),
    version_id: String(objectStat?.versionId || ''),
    size: Number(objectStat?.size) || 0,
    last_modified: objectStat?.lastModified instanceof Date
      ? objectStat.lastModified.toISOString()
      : String(objectStat?.lastModified || ''),
  });
  const sourceFingerprint = sha256Hex(sourceDescriptor);
  const physicalSourceId = sha256Hex(objectKey);

  return {
    physicalSourceId,
    sourceFingerprint,
    variant,
    objectKey: `variants/${VMD_CACHE_VERSION}/${physicalSourceId}/${sourceFingerprint}/${variant}.webp`,
  };
}

export function createVmdPersistentCache({
  client = minioClient,
  bucket = VMD_CACHE_BUCKET,
} = {}) {
  return {
    async read(identity) {
      let objectStat;
      try {
        objectStat = await client.statObject(bucket, identity.objectKey);
      } catch (error) {
        return isMissingObjectError(error)
          ? { status: 'miss' }
          : { status: 'unavailable', error };
      }

      let body;
      try {
        body = await readBoundedObject(
          client,
          bucket,
          identity.objectKey,
          objectStat.size,
        );
      } catch (error) {
        return isMissingObjectError(error)
          ? { status: 'miss' }
          : { status: 'corrupt', error };
      }

      const metadata = objectStat.metaData || {};
      const checksum = sha256Base64Url(body);
      const width = parsePositiveMetadata(metadata['vmd-width']);
      const height = parsePositiveMetadata(metadata['vmd-height']);
      const pages = parsePositiveMetadata(metadata['vmd-pages']) || 1;
      const isValid = metadata['content-type'] === 'image/webp' &&
        metadata['vmd-cache-version'] === VMD_CACHE_VERSION &&
        metadata['vmd-source-fingerprint'] === identity.sourceFingerprint &&
        metadata['vmd-variant'] === identity.variant &&
        metadata['vmd-checksum-sha256'] === checksum &&
        width !== null &&
        height !== null;

      if (!isValid) {
        return { status: 'corrupt' };
      }

      return {
        status: 'hit',
        image: {
          body,
          contentType: 'image/webp',
          width,
          height,
          pages,
          etag: `"${checksum}"`,
        },
      };
    },

    async write(identity, image) {
      if (!Buffer.isBuffer(image?.body) || image.body.length === 0) {
        throw new TypeError('VMD cache writes require a non-empty image Buffer');
      }
      if (image.body.length > MAX_VARIANT_BYTES) {
        throw new Error('Generated VMD variant exceeds the configured cache size limit');
      }

      const checksum = sha256Base64Url(image.body);
      await client.putObject(
        bucket,
        identity.objectKey,
        image.body,
        image.body.length,
        {
          'Content-Type': 'image/webp',
          'Cache-Control': 'private, no-store',
          'vmd-cache-version': VMD_CACHE_VERSION,
          'vmd-source-fingerprint': identity.sourceFingerprint,
          'vmd-variant': identity.variant,
          'vmd-checksum-sha256': checksum,
          'vmd-width': String(image.width),
          'vmd-height': String(image.height),
          'vmd-pages': String(image.pages || 1),
        },
      );

      return `"${checksum}"`;
    },
  };
}

export const vmdPersistentCache = createVmdPersistentCache();

let initializationPromise = null;

export function initializeVmdCacheStorage() {
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    const exists = await minioClient.bucketExists(VMD_CACHE_BUCKET);
    if (!exists) {
      await minioClient.makeBucket(VMD_CACHE_BUCKET);
    }

    try {
      await minioClient.setBucketPolicy(VMD_CACHE_BUCKET, '');
    } catch (error) {
      const code = String(error?.code || error?.name || '');
      const message = String(error?.message || '');
      if (!code.includes('NoSuchBucketPolicy') && !message.includes('policy does not exist')) {
        throw error;
      }
    }

    await minioClient.setBucketLifecycle(VMD_CACHE_BUCKET, {
      Rule: [{
        ID: 'expire-vmd-derived-variants',
        Status: 'Enabled',
        Filter: { Prefix: 'variants/' },
        Expiration: { Days: CACHE_RETENTION_DAYS },
      }],
    });

    return {
      bucket: VMD_CACHE_BUCKET,
      retentionDays: CACHE_RETENTION_DAYS,
    };
  })().catch((error) => {
    initializationPromise = null;
    throw error;
  });

  return initializationPromise;
}
