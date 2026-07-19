// server/routes/conversations/attachments.js
// POST /api/conversations/:conversationId/attachments
// Uploads private attachment objects and returns authenticated download URLs.

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { pool } from '../../db.js';
import { minioClient, ATTACH_BUCKET } from '../../minio.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { meetsWhoThreshold, resolvePermissions } from '../../utils/groupPermissions.js';
import sentinel, { createSentinelKey } from '../../sentinel/index.js';

const router = Router({ mergeParams: true });

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_COALESCED_ATTACHMENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_COALESCED_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
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
      `SELECT object_key
       FROM attachment_objects
       WHERE id = $1
         AND conversation_id = $2
         AND bucket = $3
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

function setAttachmentResponseHeaders(res, objectStat) {
  const storedContentType = objectStat.metaData?.['content-type'];
  const contentType = typeof storedContentType === 'string' && MIME_TYPE_PATTERN.test(storedContentType)
    ? storedContentType
    : 'application/octet-stream';

  res.setHeader('Content-Type', contentType);
  if (Number.isFinite(objectStat.size) && objectStat.size >= 0) {
    res.setHeader('Content-Length', String(objectStat.size));
  }
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
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

async function streamAttachmentObject(res, objectKey) {
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
        setAttachmentResponseHeaders(res, objectStat);
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

  setAttachmentResponseHeaders(res, objectStat);

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
// Body: { files: [{ data: '<base64 file bytes>', mime?: 'image/png' }] }
// Returns: { urls: ['/api/conversations/:id/attachments/:attachmentId'] }
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier } = req.params;
  const { files } = req.body;

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files array required' });
  }

  if (files.length > MAX_FILES) {
    return res.status(400).json({ error: `Maximum ${MAX_FILES} files per message` });
  }

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

  const urls = [];
  const blurhashes = [];

  for (const file of files) {
    const { data } = file;

    if (!data || typeof data !== 'string') {
      return res.status(400).json({ error: 'Each file must have a data field' });
    }

    const fileBuffer = Buffer.from(data, 'base64');
    if (!fileBuffer.length) {
      return res.status(400).json({ error: 'Attachment payload was empty' });
    }

    if (fileBuffer.length > MAX_FILE_BYTES) {
      return res.status(400).json({
        error: 'File too large. Maximum 10MB per attachment.',
        code: 'ATTACHMENT_TOO_LARGE',
      });
    }

    try {
      const attachmentId = randomUUID();
      const filename = `${conversation.id}/${attachmentId}.bin`;
      const contentType = typeof file?.mime === 'string' && file.mime.trim()
        ? file.mime.trim().slice(0, 255)
        : 'application/octet-stream';

      await minioClient.putObject(
        ATTACH_BUCKET,
        filename,
        fileBuffer,
        fileBuffer.length,
        {
          'Content-Type': contentType,
        }
      );

      await pool.query(
        `INSERT INTO attachment_objects (id, conversation_id, uploader_id, bucket, object_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [attachmentId, conversation.id, userId, ATTACH_BUCKET, filename]
      );

      urls.push(buildPrivateAttachmentUrl(conversation, attachmentId));
      blurhashes.push('');
    } catch (err) {
      console.error('Attachment upload error:', err);
      return res.status(500).json({ error: 'Failed to process attachment' });
    }
  }

  res.json({
    success: true,
    conversation_id: conversation.id,
    conversation_public_id: conversation.public_id ? String(conversation.public_id) : null,
    urls,
    blurhashes,
  });
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

    return streamAttachmentObject(res, attachmentObject.object_key);
  } catch (err) {
    console.error('Attachment download error:', err);
    return res.status(500).json({ error: 'Attachment download failed' });
  }
});

export default router;
