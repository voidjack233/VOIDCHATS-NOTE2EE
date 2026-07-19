import { pool } from '../db.js';
import { ATTACH_BUCKET, cdnMinioClient } from '../minio.js';

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PROTECTED_ATTACHMENT_PATH_PATTERN = new RegExp(
  `^/api/conversations/[^/]+/attachments/(${UUID_SOURCE})/?$`,
  'i',
);
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const MIN_SIGNED_URL_TTL_SECONDS = 30;
const MAX_SIGNED_URL_TTL_SECONDS = 900;
const TRANSIENT_ATTACHMENT_FIELDS = new Set([
  'fallback_url',
  'url_expires_at',
]);

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

function parseAttachmentDescriptor(rawAttachment) {
  if (typeof rawAttachment !== 'string' || rawAttachment.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawAttachment);
    if (parsed && typeof parsed === 'object' && typeof parsed.url === 'string') {
      return { ...parsed };
    }
  } catch {
    // Existing rows may contain a URL without serialized display metadata.
  }

  return { url: rawAttachment };
}

function getStableAttachmentUrl(descriptor) {
  if (typeof descriptor.fallback_url === 'string' && descriptor.fallback_url.trim()) {
    return descriptor.fallback_url.trim();
  }
  return typeof descriptor.url === 'string' ? descriptor.url.trim() : '';
}

function getProtectedAttachmentId(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url, 'https://attachment.invalid');
    const match = parsed.pathname.match(PROTECTED_ATTACHMENT_PATH_PATTERN);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function serializeStableAttachment(descriptor, stableUrl) {
  const stableDescriptor = Object.fromEntries(
    Object.entries(descriptor).filter(([key, value]) => (
      !TRANSIENT_ATTACHMENT_FIELDS.has(key) && value !== undefined
    )),
  );
  stableDescriptor.url = stableUrl;

  if (Object.keys(stableDescriptor).length === 1) {
    return stableUrl;
  }
  return JSON.stringify(stableDescriptor);
}

export function normalizeStoredAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];

  return attachments.flatMap((rawAttachment) => {
    const descriptor = parseAttachmentDescriptor(rawAttachment);
    if (!descriptor) return [];
    const stableUrl = getStableAttachmentUrl(descriptor);
    return stableUrl ? [serializeStableAttachment(descriptor, stableUrl)] : [];
  });
}

function presignAttachmentObject(objectKey) {
  return new Promise((resolve, reject) => {
    cdnMinioClient.presignedGetObject(
      ATTACH_BUCKET,
      objectKey,
      ATTACHMENT_SIGNED_URL_TTL_SECONDS,
      { 'response-cache-control': 'private, no-store' },
      (error, url) => {
        if (error) reject(error);
        else resolve(url);
      },
    );
  });
}

export async function attachSignedAttachmentUrls(messages, conversationId) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const parsedByMessage = messages.map((message) => (
    (message.attachments || []).map((rawAttachment) => {
      const descriptor = parseAttachmentDescriptor(rawAttachment);
      const stableUrl = descriptor ? getStableAttachmentUrl(descriptor) : '';
      return {
        descriptor,
        stableUrl,
        attachmentId: getProtectedAttachmentId(stableUrl),
      };
    })
  ));
  const attachmentIds = [...new Set(
    parsedByMessage.flat().map((entry) => entry.attachmentId).filter(Boolean),
  )];

  if (attachmentIds.length === 0) return messages;

  try {
    const result = await pool.query(
      `SELECT id::text AS id, object_key
       FROM attachment_objects
       WHERE conversation_id = $1
         AND bucket = $2
         AND id = ANY($3::uuid[])`,
      [conversationId, ATTACH_BUCKET, attachmentIds],
    );
    const objectKeyById = new Map(result.rows.map((row) => [row.id, row.object_key]));
    const signingStartedAt = Date.now();
    const signedEntries = await Promise.all(
      [...objectKeyById.entries()].map(async ([attachmentId, objectKey]) => ([
        attachmentId,
        await presignAttachmentObject(objectKey),
      ])),
    );
    const signedUrlById = new Map(signedEntries);
    const expiresAt = signingStartedAt + (ATTACHMENT_SIGNED_URL_TTL_SECONDS * 1000);

    return messages.map((message, messageIndex) => ({
      ...message,
      attachments: parsedByMessage[messageIndex].map((entry, attachmentIndex) => {
        if (!entry.descriptor || !entry.stableUrl || !entry.attachmentId) {
          return message.attachments[attachmentIndex];
        }

        const signedUrl = signedUrlById.get(entry.attachmentId);
        if (!signedUrl) {
          return serializeStableAttachment(entry.descriptor, entry.stableUrl);
        }

        return JSON.stringify({
          ...entry.descriptor,
          id: entry.attachmentId,
          url: signedUrl,
          fallback_url: entry.stableUrl,
          url_expires_at: expiresAt,
        });
      }),
    }));
  } catch (error) {
    console.warn('[ATTACHMENT_DELIVERY] signed URL generation failed; using protected URLs', {
      conversation_id: conversationId,
      error: error instanceof Error ? error.message : String(error || ''),
    });
    return messages.map((message, messageIndex) => ({
      ...message,
      attachments: parsedByMessage[messageIndex].map((entry, attachmentIndex) => (
        entry.descriptor && entry.stableUrl
          ? serializeStableAttachment(entry.descriptor, entry.stableUrl)
          : message.attachments[attachmentIndex]
      )),
    }));
  }
}
