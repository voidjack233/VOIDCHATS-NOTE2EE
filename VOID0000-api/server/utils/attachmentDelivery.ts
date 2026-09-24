import { pool } from '../db.js';
import { ATTACH_BUCKET, cdnMinioClient, minioClient } from '../minio.js';
import { createVmdResponsiveImageDelivery } from '../vmd/capability.js';
import {
  createAttachmentDeliveryMapper,
  normalizeStoredAttachments,
  resolveAttachmentDeliveryMaxConcurrency,
  type AttachmentObject,
} from './attachmentDeliveryCore.js';
import {
  createPresignedAttachmentPolicyParams,
  resolvePersistedAttachmentPolicy,
  resolveStoredAttachmentPolicy,
  type AttachmentStoragePolicy,
} from './attachmentContentPolicy.js';

const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60;
const MIN_SIGNED_URL_TTL_SECONDS = 30;
const MAX_SIGNED_URL_TTL_SECONDS = 60 * 60;

function resolveSignedUrlTtlSeconds(): number {
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

function presignAttachmentObject(
  objectKey: string,
  policy: AttachmentStoragePolicy,
): Promise<string> {
  return cdnMinioClient.presignedGetObject(
    ATTACH_BUCKET,
    objectKey,
    ATTACHMENT_SIGNED_URL_TTL_SECONDS,
    createPresignedAttachmentPolicyParams(policy),
  );
}

export async function createSignedAttachmentDelivery(
  objectKey: string,
  attachmentObject: Partial<AttachmentObject> = {},
) {
  const signingStartedAt = Date.now();
  const policy = resolvePersistedAttachmentPolicy({
    content_hash: attachmentObject.content_hash,
    content_type: attachmentObject.content_type,
    inline: attachmentObject.inline,
    status: attachmentObject.blob_status,
  }, objectKey, attachmentObject.filename) ?? resolveStoredAttachmentPolicy(
    await minioClient.statObject(ATTACH_BUCKET, objectKey), objectKey, attachmentObject.filename,
  );
  const url = await presignAttachmentObject(
    objectKey,
    policy,
  );
  let video: Record<string, unknown> = {};
  if (policy.contentType === 'video/mp4' && policy.inline && attachmentObject.video_metadata && typeof attachmentObject.video_metadata === 'object' && typeof attachmentObject.poster_key === 'string') {
    const posterPolicy = resolvePersistedAttachmentPolicy({
      content_hash: attachmentObject.poster_content_hash,
      content_type: attachmentObject.poster_content_type,
      inline: attachmentObject.poster_inline,
      status: attachmentObject.poster_blob_status,
    }, attachmentObject.poster_key, 'poster.webp') ?? resolveStoredAttachmentPolicy(
      await minioClient.statObject(ATTACH_BUCKET, attachmentObject.poster_key), attachmentObject.poster_key, 'poster.webp',
    );
    if (posterPolicy.inline && posterPolicy.contentType === 'image/webp') {
      video = { ...attachmentObject.video_metadata, video_trusted: true, poster: {
        ...((attachmentObject.video_metadata as Record<string, unknown>).poster as Record<string, unknown> || {}),
        url: await presignAttachmentObject(attachmentObject.poster_key, posterPolicy),
        url_expires_at: signingStartedAt + ATTACHMENT_SIGNED_URL_TTL_SECONDS * 1000,
      } };
    }
  }
  return {
    url,
    url_expires_at: signingStartedAt + (ATTACHMENT_SIGNED_URL_TTL_SECONDS * 1000),
    inline: policy.inline,
    content_type: policy.contentType,
    video,
  };
}

const attachSignedAttachmentUrls = createAttachmentDeliveryMapper({
  queryAttachmentObjects: async (conversationId, attachmentIds) => {
    const result = await pool.query(
      `SELECT attachment.id::text AS id,
              blob.object_key,
              blob.content_hash, blob.content_type, blob.inline, blob.status AS blob_status,
              poster.content_hash AS poster_content_hash,
              poster.content_type AS poster_content_type,
              poster.inline AS poster_inline, poster.status AS poster_blob_status,
              attachment.filename, attachment.video_metadata, poster.object_key AS poster_key
       FROM attachment_objects AS attachment
       JOIN attachment_blobs AS blob
         ON blob.id = attachment.blob_id
       LEFT JOIN attachment_blobs AS poster
         ON poster.id = attachment.poster_blob_id AND poster.bucket = $2
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
