// server/routes/conversations/attachments.js
// POST /api/conversations/:conversationId/attachments
// Uploads private attachment objects and returns authenticated download URLs.

import { Router } from 'express';
import {
  AttachmentLifecycleError,
  attachmentLifecycle,
} from '../../attachments/lifecycle.js';
import {
  AttachmentRawUploadError,
  parseAttachmentRawRequest,
} from '../../attachments/rawUpload.js';
import {
  createAttachmentUploadProcessor,
} from '../../attachments/uploadProcessor.js';
import { pool } from '../../db.js';
import { minioClient, ATTACH_BUCKET } from '../../minio.js';
import { attachmentUploadLimiter } from '../../middleware/rate_limit.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { meetsWhoThreshold, resolvePermissions } from '../../utils/groupPermissions.js';
import {
  AttachmentSanitizerTransportError,
  ChatImageSanitizationError,
} from '../../utils/chatImageErrors.js';
import { MAX_CHAT_ATTACHMENT_BYTES } from '../../utils/chatImageLimits.js';
import {
  sanitizeChatAttachmentImageInWorker,
} from '../../attachmentSanitizer/client.js';
import sentinel, { createSentinelKey } from '../../sentinel/index.js';
import {
  createAttachmentBlobMetadata,
  createProtectedAttachmentResponseHeaders,
  createAttachmentStoragePolicy,
} from '../../utils/attachmentContentPolicy.js';

const router = Router({ mergeParams: true });

const MAX_FILE_BYTES = MAX_CHAT_ATTACHMENT_BYTES;
const DEFAULT_MAX_COALESCED_ATTACHMENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_COALESCED_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveByteLimit(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = value == null ? '' : String(value).trim();
  if (normalized === '') {
    return fallback;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, maximum)
    : fallback;
}

const MAX_COALESCED_ATTACHMENT_BYTES = resolveByteLimit(
  process.env.SENTINEL_MAX_BUFFERED_ATTACHMENT_BYTES,
  DEFAULT_MAX_COALESCED_ATTACHMENT_BYTES,
  MAX_FILE_BYTES,
);
const MAX_TOTAL_COALESCED_ATTACHMENT_BYTES = resolveByteLimit(
  process.env.SENTINEL_MAX_TOTAL_BUFFERED_ATTACHMENT_BYTES,
  DEFAULT_MAX_TOTAL_COALESCED_ATTACHMENT_BYTES,
);
let reservedCoalescedAttachmentBytes = 0;

class AttachmentBufferLimitError extends Error {}

function getConversationDownloadIdentifier(conversation) {
  return conversation.public_id ? String(conversation.public_id) : String(conversation.id);
}

function buildPrivateAttachmentUrl(conversation, attachmentId) {
  return `/api/conversations/${encodeURIComponent(getConversationDownloadIdentifier(conversation))}/attachments/${attachmentId}`;
}

const processAttachmentUpload = createAttachmentUploadProcessor({
  sanitizeImage: sanitizeChatAttachmentImageInWorker,
  createStoragePolicy: createAttachmentStoragePolicy,
  createObjectMetadata: createAttachmentBlobMetadata,
  lifecycle: attachmentLifecycle,
});

async function resolveConversationForMember(conversationIdentifier, userId) {
  const conversation = await findConversationByIdentifier(conversationIdentifier);
  if (!conversation) {
    return { status: 404, body: { error: 'Conversation not found' } };
  }

  const member = await pool.query(
    `SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
    [conversation.id, userId]
  );
  if (member.rows.length === 0) {
    return { status: 403, body: { error: 'Not a member of this conversation' } };
  }

  return { conversation, member: member.rows[0] };
}

async function findAttachmentObject(conversationId, attachmentId) {
  const attachmentFlightKey = createSentinelKey(
    'postgres.attachment-objects.by-id',
    conversationId,
    attachmentId,
    ATTACH_BUCKET,
  );
  const result = await sentinel.guard(
    attachmentFlightKey,
    () => pool.query(
      `SELECT blob.object_key, attachment.filename
       FROM attachment_objects AS attachment
       JOIN attachment_blobs AS blob
         ON blob.id = attachment.blob_id
       WHERE attachment.id = $1
         AND attachment.conversation_id = $2
         AND blob.bucket = $3
       LIMIT 1`,
      [attachmentId, conversationId, ATTACH_BUCKET],
    ),
  );
  return result.rows[0] || null;
}

function statAttachmentObject(objectKey) {
  const statFlightKey = createSentinelKey('minio.attachments.stat', ATTACH_BUCKET, objectKey);
  return sentinel.guard(
    statFlightKey,
    () => minioClient.statObject(ATTACH_BUCKET, objectKey),
  );
}

function setAttachmentResponseHeaders(res, objectStat, objectKey, logicalFilename) {
  const headers = createProtectedAttachmentResponseHeaders(
    objectStat,
    objectKey,
    logicalFilename,
  );
  Object.entries(headers).forEach(([name, value]) => {
    res.setHeader(name, value);
  });
  if (Number.isFinite(objectStat.size) && objectStat.size >= 0) {
    res.setHeader('Content-Length', String(objectStat.size));
  }
}

async function readAttachmentObject(objectKey) {
  const objectStream = await minioClient.getObject(ATTACH_BUCKET, objectKey);
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of objectStream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_COALESCED_ATTACHMENT_BYTES) {
      objectStream.destroy();
      throw new AttachmentBufferLimitError('Attachment exceeded the Sentinel buffering limit');
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, totalBytes);
}

async function readAttachmentObjectWithinBudget(objectKey, objectSize) {
  if (
    MAX_TOTAL_COALESCED_ATTACHMENT_BYTES === 0 ||
    reservedCoalescedAttachmentBytes + objectSize > MAX_TOTAL_COALESCED_ATTACHMENT_BYTES
  ) {
    return null;
  }

  reservedCoalescedAttachmentBytes += objectSize;
  try {
    return await readAttachmentObject(objectKey);
  } finally {
    reservedCoalescedAttachmentBytes -= objectSize;
  }
}

async function streamAttachmentObject(res, objectKey, logicalFilename) {
  let objectStat;
  try {
    objectStat = await statAttachmentObject(objectKey);
  } catch {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  if (
    sentinel.isEnabled &&
    MAX_COALESCED_ATTACHMENT_BYTES > 0 &&
    Number.isFinite(objectStat.size) &&
    objectStat.size >= 0 &&
    objectStat.size <= MAX_COALESCED_ATTACHMENT_BYTES
  ) {
    try {
      const objectFlightKey = createSentinelKey('minio.attachments.object', ATTACH_BUCKET, objectKey);
      const objectBuffer = await sentinel.guard(
        objectFlightKey,
        () => readAttachmentObjectWithinBudget(objectKey, objectStat.size),
      );
      if (objectBuffer) {
        setAttachmentResponseHeaders(res, objectStat, objectKey, logicalFilename);
        return res.end(objectBuffer);
      }
    } catch (err) {
      if (err instanceof AttachmentBufferLimitError) {
        try {
          objectStat = await statAttachmentObject(objectKey);
        } catch {
          return res.status(404).json({ error: 'Attachment not found' });
        }
      } else {
        return res.status(404).json({ error: 'Attachment not found' });
      }
    }
  }

  let objectStream;
  try {
    objectStream = await minioClient.getObject(ATTACH_BUCKET, objectKey);
  } catch {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  setAttachmentResponseHeaders(res, objectStat, objectKey, logicalFilename);

  objectStream.on('error', (err) => {
    console.error('Attachment download stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Attachment download failed' });
      return;
    }
    res.destroy(err);
  });

  objectStream.pipe(res);
}

// POST /api/conversations/:conversationId/attachments
// application/octet-stream: one raw file plus bounded untrusted metadata headers.
// Returns: { urls: ['/api/conversations/:id/attachments/:attachmentId'] }
router.post('/', attachmentUploadLimiter, async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier } = req.params;

  let conversation;

  try {
    const resolved = await resolveConversationForMember(conversationIdentifier, userId);
    if (!resolved.conversation) {
      return res.status(resolved.status).json(resolved.body);
    }

    conversation = resolved.conversation;

    if (conversation.type === 'group' || conversation.type === 'channel') {
      let permissionsSource = conversation.permissions;
      if (conversation.type === 'channel' && conversation.parent_conversation_id) {
        const parentResult = await pool.query(
          'SELECT permissions FROM conversations WHERE id = $1 LIMIT 1',
          [conversation.parent_conversation_id]
        );
        if (parentResult.rows.length > 0) {
          permissionsSource = parentResult.rows[0].permissions;
        }
      }
      const perms = resolvePermissions(permissionsSource);
      if (!meetsWhoThreshold(resolved.member.role, perms.who_can_send_attachments)) {
        return res.status(403).json({ error: 'You do not have permission to send attachments' });
      }
    }
  } catch {
    return res.status(500).json({ error: 'Membership check failed' });
  }

  let parsedUpload;
  try {
    parsedUpload = await parseAttachmentRawRequest(req);
  } catch (error) {
    if (error instanceof AttachmentRawUploadError) {
      return res.status(error.status).json(error.body);
    }
    console.error('Attachment binary parsing error:', error);
    return res.status(400).json({
      error: 'Attachment binary payload is malformed',
      code: 'ATTACHMENT_UPLOAD_INVALID',
    });
  }

  try {
    const response = await processAttachmentUpload({
      userId,
      conversation,
      files: [parsedUpload.file],
      buildPrivateUrl: buildPrivateAttachmentUrl,
    });
    return res.json(response);
  } catch (error) {
    if (error instanceof ChatImageSanitizationError) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof AttachmentSanitizerTransportError) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      });
    }
    if (error instanceof AttachmentLifecycleError) {
      return res.status(error.status).json(error.body);
    }
    console.error('Attachment upload error:', error);
    return res.status(500).json({ error: 'Failed to process attachment' });
  }
});

// DELETE /api/conversations/:conversationId/attachments/:attachmentId
// Best-effort composer cleanup for an attachment that has not been sent.
router.delete('/:attachmentId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, attachmentId } = req.params;

  if (!UUID_PATTERN.test(attachmentId || '')) {
    return res.status(400).json({ error: 'Invalid attachment id' });
  }

  try {
    const resolved = await resolveConversationForMember(conversationIdentifier, userId);
    if (!resolved.conversation) {
      return res.status(resolved.status).json(resolved.body);
    }

    await attachmentLifecycle.deleteStagedAttachment({
      attachmentId,
      userId,
      conversationId: resolved.conversation.id,
    });
    return res.status(204).end();
  } catch (error) {
    if (error instanceof AttachmentLifecycleError) {
      return res.status(error.status).json(error.body);
    }
    console.error('Attachment staged deletion error:', error);
    return res.status(500).json({ error: 'Failed to remove staged attachment' });
  }
});

// GET /api/conversations/:conversationId/attachments/:attachmentId
router.get('/:attachmentId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, attachmentId } = req.params;

  if (!UUID_PATTERN.test(attachmentId || '')) {
    return res.status(400).json({ error: 'Invalid attachment id' });
  }

  try {
    const resolved = await resolveConversationForMember(conversationIdentifier, userId);
    if (!resolved.conversation) {
      return res.status(resolved.status).json(resolved.body);
    }

    const attachmentObject = await findAttachmentObject(resolved.conversation.id, attachmentId);
    if (!attachmentObject) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    return streamAttachmentObject(
      res,
      attachmentObject.object_key,
      attachmentObject.filename,
    );
  } catch (err) {
    console.error('Attachment download error:', err);
    return res.status(500).json({ error: 'Attachment download failed' });
  }
});

export default router;
