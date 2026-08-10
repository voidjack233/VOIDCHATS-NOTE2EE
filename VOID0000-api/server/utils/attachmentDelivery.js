import { pool } from '../db.js';
import { ATTACH_BUCKET, cdnMinioClient, minioClient } from '../minio.js';
import { createVmdResponsiveImageDelivery } from '../vmd/capability.js';
import {
  createAttachmentDeliveryMapper,
  normalizeStoredAttachments,
  resolveAttachmentDeliveryMaxConcurrency,
} from './attachmentDeliveryCore.js';
import {
  createPresignedAttachmentResponseParams,
  resolveStoredAttachmentPolicy,
} from './attachmentContentPolicy.js';

const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60;
const MIN_SIGNED_URL_TTL_SECONDS = 30;
const MAX_SIGNED_URL_TTL_SECONDS = 60 * 60;

function resolveSignedUrlTtlSeconds() {
  const configured = Number(process.env.ATTACHMENT_SIGNED_URL_TTL_SECONDS);
  if (!Number.isInteger(configured)) {
    return DEFAULT_SIGNED_URL_TTL_SECONDS;
  }
  return Math.min(
    MAX_SIGNED_URL_TTL_SECONDS,
    Math.max(MIN_SIGNED_URL_TTL_SECONDS, configured),
  );
}

export const ATTACHMENT_SIGNED_URL_TTL_SECONDS = resolveSignedUrlTtlSeconds();
export const ATTACHMENT_DELIVERY_MAX_CONCURRENCY =
  resolveAttachmentDeliveryMaxConcurrency(
    process.env.ATTACHMENT_DELIVERY_MAX_CONCURRENCY,
  );
export { normalizeStoredAttachments };

function presignAttachmentObject(objectKey, objectStat, logicalFilename) {
  return new Promise((resolve, reject) => {
    cdnMinioClient.presignedGetObject(
      ATTACH_BUCKET,
      objectKey,
      ATTACHMENT_SIGNED_URL_TTL_SECONDS,
      createPresignedAttachmentResponseParams(objectStat, objectKey, logicalFilename),
      (error, url) => {
        if (error) reject(error);
        else resolve(url);
      },
    );
  });
}

export async function createSignedAttachmentDelivery(objectKey, attachmentObject = {}) {
  const signingStartedAt = Date.now();
  const objectStat = await minioClient.statObject(ATTACH_BUCKET, objectKey);
  const policy = resolveStoredAttachmentPolicy(objectStat, objectKey);
  const url = await presignAttachmentObject(
    objectKey,
    objectStat,
    attachmentObject.filename,
  );
  return {
    url,
    url_expires_at: signingStartedAt + (ATTACHMENT_SIGNED_URL_TTL_SECONDS * 1000),
    inline: policy.inline,
  };
}

const attachSignedAttachmentUrls = createAttachmentDeliveryMapper({
  queryAttachmentObjects: async (conversationId, attachmentIds) => {
    const result = await pool.query(
      `SELECT attachment.id::text AS id,
              blob.object_key,
              attachment.filename
       FROM attachment_objects AS attachment
       JOIN attachment_blobs AS blob
         ON blob.id = attachment.blob_id
       WHERE attachment.conversation_id = $1
         AND blob.bucket = $2
         AND attachment.id = ANY($3::uuid[])`,
      [conversationId, ATTACH_BUCKET, attachmentIds],
    );
    return result.rows;
  },
  createOriginalDelivery: createSignedAttachmentDelivery,
  createImageDelivery: createVmdResponsiveImageDelivery,
  maxConcurrency: ATTACHMENT_DELIVERY_MAX_CONCURRENCY,
});

export { attachSignedAttachmentUrls };
