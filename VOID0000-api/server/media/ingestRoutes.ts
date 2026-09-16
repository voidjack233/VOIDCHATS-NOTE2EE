import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import valkey from '../valkey.js';
import { minioClient, ensurePrivateBucket, ATTACH_BUCKET, BUCKET, GROUP_AVATAR_BUCKET } from '../minio.js';
import { findConversationByIdentifier } from '../utils/conversationIdentity.js';
import { canInteractInConversation } from '../utils/conversationInteraction.js';
import { meetsWhoThreshold, resolvePermissions } from '../utils/groupPermissions.js';
import { attachmentUploadLimiter } from '../middleware/rate_limit.js';
import { sanitizeAttachmentFilename } from '../utils/attachmentContentPolicy.js';
import { resolveAttachmentLifecycleConfig, assertStagedUploadQuota } from '../attachments/lifecycleCore.js';
import { attachmentLifecycle } from '../attachments/lifecycle.js';
import { VIDEO_STREAM, VIDEO_SOURCE_MAX_BYTES, videoJobFields } from './protocol.js';
import { VideoUploadError, videoContentLength, streamQuarantineUpload } from './streamUpload.js';

const router = Router({ mergeParams: true });
const bucket = process.env.MINIO_MEDIA_QUARANTINE_BUCKET || 'media-quarantine';
if ([ATTACH_BUCKET, BUCKET, GROUP_AVATAR_BUCKET, process.env.MINIO_VMD_CACHE_BUCKET || 'vmd-variants'].includes(bucket)) {
  throw new Error('Media quarantine must use a distinct private bucket');
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const config = resolveAttachmentLifecycleConfig();
let initialization: Promise<void> | undefined;
function ensureQuarantine() {
  return initialization ??= ensurePrivateBucket(bucket).catch(error => { initialization = undefined; throw error; });
}

router.use(async (req, res, next) => {
  try {
    if (!req.user?.id) { res.status(401).json({ error: 'Authentication required' }); return; }
    const conversation = await findConversationByIdentifier(req.params.conversationId);
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }
    const member = await pool.query('SELECT role FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [conversation.id, req.user.id]);
    if (!member.rows.length) { res.status(403).json({ error: 'Not a conversation member' }); return; }
    if (req.method === 'POST') {
      if (!await canInteractInConversation(pool, conversation, req.user.id)) { res.status(403).json({ error: 'Cannot interact in conversation' }); return; }
      let permissions = conversation.permissions;
      if (conversation.type === 'channel' && conversation.parent_conversation_id) {
        permissions = (await pool.query('SELECT permissions FROM conversations WHERE id=$1', [conversation.parent_conversation_id])).rows[0]?.permissions;
      }
      if (['group', 'channel'].includes(conversation.type) && !meetsWhoThreshold(member.rows[0].role, resolvePermissions(permissions).who_can_send_attachments)) {
        res.status(403).json({ error: 'Attachment permission denied' }); return;
      }
    }
    res.locals.mediaConversation = conversation;
    next();
  } catch { res.status(503).json({ error: 'Media authorization unavailable' }); }
});

router.post('/', attachmentUploadLimiter, async (req, res) => {
  const userId = req.user!.id;
  const conversation = res.locals.mediaConversation;
  let id = '';
  let ownsUpload = false;
  try {
    if (req.headers['content-type'] !== 'application/octet-stream' || req.headers['content-encoding']) throw new VideoUploadError(415, 'MEDIA_BINARY_REQUIRED');
    const declared = videoContentLength(req.headers['content-length']);
    const candidate = req.headers['x-media-ingest-id'];
    id = candidate === undefined ? randomUUID() : String(candidate);
    if (!uuid.test(id)) throw new VideoUploadError(400, 'MEDIA_ID_INVALID');
    const name = req.headers['x-attachment-filename'];
    if (name !== undefined && (typeof name !== 'string' || name.length > 2048)) throw new VideoUploadError(400, 'MEDIA_METADATA_INVALID');
    let filename: string;
    try { filename = sanitizeAttachmentFilename(decodeURIComponent(name || 'video.mp4')); } catch { throw new VideoUploadError(400, 'MEDIA_METADATA_INVALID'); }
    await ensureQuarantine();
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`attachment-staged-quota:${userId}`]);
      const existing = await db.query('SELECT uploader_id,conversation_id,status FROM media_ingests WHERE id=$1', [id]);
      if (existing.rows.length) {
        const row = existing.rows[0];
        if (row.uploader_id !== userId || row.conversation_id !== conversation.id || row.status === 'uploading') throw new VideoUploadError(409, 'MEDIA_INGEST_CONFLICT');
        await db.query('COMMIT'); req.resume(); res.status(202).json({ success: true, ingest_id: id, status: row.status }); return;
      }
      const usage = await db.query(`SELECT COUNT(*)::int AS count,COALESCE(SUM(size),0)::bigint AS bytes FROM (
        SELECT size_bytes AS size FROM attachment_objects WHERE uploader_id=$1 AND status='staged'
        UNION ALL SELECT reserved_bytes FROM media_ingests WHERE uploader_id=$1 AND status IN ('uploading','queued','probing','processing','finalizing')
      ) pending`, [userId]);
      assertStagedUploadQuota({ currentCount: Number(usage.rows[0].count), currentBytes: Number(usage.rows[0].bytes), incomingCount: 1,
        incomingBytes: VIDEO_SOURCE_MAX_BYTES, maxCount: config.stagedMaxCount, maxBytes: config.stagedMaxBytes });
      await db.query(`INSERT INTO media_ingests(id,uploader_id,conversation_id,quarantine_object_key,filename,expires_at)
        VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '15 minutes')`, [id, userId, conversation.id, `video/${id}/source`, filename]);
      await db.query('COMMIT'); ownsUpload = true;
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; } finally { db.release(); }
    const signedPut = await minioClient.presignedPutObject(bucket, `video/${id}/source`, 120);
    const bytes = await streamQuarantineUpload(req, signedPut, declared);
    const queued = await pool.query(`UPDATE media_ingests SET status='queued',source_bytes=$2,updated_at=NOW(),expires_at=NOW()+INTERVAL '24 hours'
      WHERE id=$1 AND status='uploading' RETURNING id`, [id, bytes]);
    if (queued.rowCount !== 1) throw new VideoUploadError(409, 'MEDIA_UPLOAD_CANCELLED');
    // DB is the outbox. XADD failure does not discard an accepted private source.
    let publicationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        valkey.xadd(VIDEO_STREAM, 'MAXLEN', '~', 10000, '*', ...videoJobFields(id, conversation.id)),
        new Promise((_, reject) => { publicationTimer = setTimeout(() => reject(new Error('Media publication timeout')), 2000); }),
      ]);
      await pool.query('UPDATE media_ingests SET last_enqueued_at=NOW() WHERE id=$1', [id]);
    } catch { console.warn('[MEDIA] queue publication deferred', { ingest_id: id }); }
    finally { clearTimeout(publicationTimer); }
    res.status(202).json({ success: true, ingest_id: id, status: 'queued' });
  } catch (error) {
    if (ownsUpload) {
      // Never delete a source after an uncertain queued COMMIT. Only a confirmed
      // uploading->failed transition gives this request permission to clean it.
      const failed = await pool.query(`UPDATE media_ingests SET status='failed',error_code=$2,completed_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND status='uploading' RETURNING id`, [id, error instanceof VideoUploadError ? error.code : 'MEDIA_UPLOAD_FAILED']).catch(() => null);
      if (failed?.rowCount === 1) await minioClient.removeObject(bucket, `video/${id}/source`).catch(() => {});
    }
    req.resume();
    const status = error instanceof VideoUploadError ? error.status : (error && typeof error === 'object' && 'status' in error ? Number(error.status) : 503);
    if (!res.headersSent && !res.destroyed) res.status(status).json({ error: 'Video upload failed', code: error instanceof VideoUploadError ? error.code : 'MEDIA_UPLOAD_FAILED' });
  }
});

router.get('/:ingestId', async (req, res) => {
  if (!uuid.test(req.params.ingestId)) { res.status(400).json({ error: 'Invalid ingest' }); return; }
  try {
    const result = await pool.query(`SELECT ingest.id,ingest.status,ingest.error_code,attachment.id AS attachment_id,
      attachment.video_metadata,attachment.size_bytes FROM media_ingests ingest
      LEFT JOIN attachment_objects attachment ON attachment.id=ingest.final_attachment_id
      WHERE ingest.id=$1 AND ingest.uploader_id=$2 AND ingest.conversation_id=$3`, [req.params.ingestId, req.user!.id, res.locals.mediaConversation.id]);
    const row = result.rows[0]; if (!row) { res.status(404).json({ error: 'Ingest not found' }); return; }
    if (row.status === 'ready' && !row.attachment_id) { res.status(410).json({ error: 'Attachment removed', code: 'MEDIA_REMOVED' }); return; }
    const identifier = res.locals.mediaConversation.public_id || res.locals.mediaConversation.id;
    res.json({ success: true, ingest_id: row.id, status: row.status, error_code: row.error_code,
      ...(row.status === 'ready' ? { attachment: { ...row.video_metadata, size: Number(row.size_bytes),
        url: `/api/conversations/${identifier}/attachments/${row.attachment_id}` } } : {}) });
  } catch { res.status(503).json({ error: 'Video status unavailable' }); }
});

router.delete('/:ingestId', async (req, res) => {
  if (!uuid.test(req.params.ingestId)) { res.status(400).json({ error: 'Invalid ingest' }); return; }
  try {
    // Active processing is fenced immediately; the worker cancels its command on
    // the next lease check and terminal cleanup retries source removal.
    await pool.query(`UPDATE media_ingests SET status='cancelled',lease_token=NULL,lease_until=NULL,
      completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND uploader_id=$2 AND conversation_id=$3
      AND status IN ('uploading','queued','probing','processing','finalizing')`, [req.params.ingestId, req.user!.id, res.locals.mediaConversation.id]);
    // Finalization may have won the row lock immediately before cancellation.
    // The normal staged-only deletion policy must still own this cleanup.
    const ready = await pool.query(`SELECT final_attachment_id FROM media_ingests WHERE id=$1 AND uploader_id=$2 AND conversation_id=$3 AND status='ready'`,
      [req.params.ingestId, req.user!.id, res.locals.mediaConversation.id]);
    if (ready.rows[0]?.final_attachment_id) {
      await attachmentLifecycle.deleteStagedAttachment({ attachmentId: ready.rows[0].final_attachment_id,
        userId: req.user!.id, conversationId: res.locals.mediaConversation.id });
    }
    res.status(204).end();
  } catch { res.status(503).json({ error: 'Video cancellation unavailable' }); }
});
export default router;
