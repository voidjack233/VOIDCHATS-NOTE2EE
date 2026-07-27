import { randomUUID } from 'node:crypto';

import {
  createAttachmentObjectMetadata,
  createAttachmentStoragePolicy,
  getStoredAttachmentSanitizerMarker,
  resolveStoredAttachmentPolicy,
} from '../../server/utils/attachmentContentPolicy.js';
import { MAX_CHAT_ATTACHMENT_BYTES } from '../../server/utils/chatImageLimits.js';

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, 'i');
const ATTACHMENT_PATH_PATTERN = new RegExp(`/attachments/(${UUID_SOURCE})(?:/)?$`, 'i');
const IMAGE_FILENAME_PATTERN = /\.(avif|bmp|gif|jpe?g|png|svg|tiff?|webp)$/i;

function getMetadataValue(objectStat, names) {
  const metadata = objectStat?.metaData;
  if (!metadata || typeof metadata !== 'object') return '';

  const expectedNames = new Set(names.map((name) => name.toLowerCase()));
  const entry = Object.entries(metadata).find(([name]) => (
    expectedNames.has(name.toLowerCase())
  ));
  return entry?.[1] == null ? '' : String(entry[1]);
}

function getStoredContentType(objectStat) {
  return getMetadataValue(objectStat, ['content-type']);
}

function getStoredFilename(objectStat) {
  return getMetadataValue(objectStat, [
    'original-filename',
    'x-amz-meta-original-filename',
  ]);
}

function normalizeEtag(value) {
  return typeof value === 'string' ? value.replaceAll('"', '').trim() : '';
}

function isMissingObjectError(error) {
  const code = String(error?.code || error?.name || '');
  return ['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(code);
}

export function parseLegacyAttachmentDescriptor(rawAttachment) {
  if (typeof rawAttachment !== 'string' || rawAttachment.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawAttachment);
    if (parsed && typeof parsed === 'object' && typeof parsed.url === 'string') {
      return { ...parsed };
    }
  } catch {
    // Legacy message rows may store only the protected attachment URL.
  }

  return { url: rawAttachment };
}

export function getLegacyDescriptorAttachmentId(descriptor) {
  if (UUID_PATTERN.test(descriptor?.id || '')) {
    return String(descriptor.id).toLowerCase();
  }

  if (typeof descriptor?.url !== 'string') return null;
  try {
    const parsed = new URL(descriptor.url, 'https://attachment.invalid');
    return parsed.pathname.match(ATTACHMENT_PATH_PATTERN)?.[1]?.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function isLegacyImageCandidateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return false;

  const mime = typeof descriptor.mime === 'string'
    ? descriptor.mime.split(';', 1)[0].trim().toLowerCase()
    : '';
  if (mime.startsWith('image/')) return true;

  const width = Number(descriptor.width);
  const height = Number(descriptor.height);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return true;
  }

  return typeof descriptor.name === 'string' &&
    IMAGE_FILENAME_PATTERN.test(descriptor.name.trim());
}

export function buildTrustedLegacyImageMetadata({
  sanitizedImage,
  originalName,
}) {
  const policy = createAttachmentStoragePolicy({
    sanitizedImage,
    originalName,
  });
  if (!policy.inline) {
    const error = new Error('Sanitizer output did not produce a trusted inline image');
    error.code = 'LEGACY_IMAGE_POLICY_REJECTED';
    throw error;
  }

  return {
    policy,
    metadata: createAttachmentObjectMetadata(policy),
  };
}

export function verifyTrustedLegacyImageStat(objectStat, {
  contentType,
  size,
}) {
  const policy = resolveStoredAttachmentPolicy(objectStat);
  const marker = getStoredAttachmentSanitizerMarker(objectStat);
  const actualSize = Number(objectStat?.size);

  if (
    marker !== '1' ||
    policy.inline !== true ||
    policy.contentType !== contentType ||
    !Number.isSafeInteger(actualSize) ||
    actualSize !== size
  ) {
    const error = new Error('Stored sanitized image verification failed');
    error.code = 'LEGACY_IMAGE_REPLACEMENT_VERIFICATION_FAILED';
    throw error;
  }

  return policy;
}

function verifyBackupStat(backupStat, originalStat) {
  const backupSize = Number(backupStat?.size);
  const originalSize = Number(originalStat?.size);
  const backupEtag = normalizeEtag(backupStat?.etag);
  const originalEtag = normalizeEtag(originalStat?.etag);
  if (
    !Number.isSafeInteger(backupSize) ||
    backupSize !== originalSize ||
    (backupEtag && originalEtag && backupEtag !== originalEtag) ||
    getStoredContentType(backupStat) !== getStoredContentType(originalStat) ||
    getStoredAttachmentSanitizerMarker(backupStat) !==
      getStoredAttachmentSanitizerMarker(originalStat)
  ) {
    const error = new Error('Legacy attachment backup verification failed');
    error.code = 'LEGACY_IMAGE_BACKUP_VERIFICATION_FAILED';
    throw error;
  }
}

async function removeTemporaryObject(objectStore, objectKey) {
  if (!objectKey) return;
  try {
    await objectStore.removeObject(objectKey);
  } catch {
    // A stale migration temp object is harmless and can be cleaned separately.
  }
}

/**
 * MinIO PUT and server-side COPY publish an object only after the operation
 * completes. A verified backup remains available until all post-copy checks
 * finish, so a failed replacement can restore the original stable object key.
 */
export async function replaceLegacyObjectSafely({
  attachmentId,
  objectKey,
  originalStat,
  sanitizedBuffer,
  metadata,
  contentType,
  objectStore,
  afterReplacement,
}) {
  const operationId = randomUUID();
  const temporaryPrefix = `.void-legacy-resanitize/${attachmentId}/${operationId}`;
  const sanitizedObjectKey = `${temporaryPrefix}.sanitized`;
  const backupObjectKey = `${temporaryPrefix}.backup`;
  let backupReady = false;
  let replacementAttempted = false;

  try {
    await objectStore.putObject(sanitizedObjectKey, sanitizedBuffer, metadata);
    const stagedStat = await objectStore.statObject(sanitizedObjectKey);
    verifyTrustedLegacyImageStat(stagedStat, {
      contentType,
      size: sanitizedBuffer.length,
    });

    await objectStore.copyObject(objectKey, backupObjectKey, {
      matchEtag: normalizeEtag(originalStat?.etag),
    });
    const backupStat = await objectStore.statObject(backupObjectKey);
    verifyBackupStat(backupStat, originalStat);
    backupReady = true;

    replacementAttempted = true;
    await objectStore.copyObject(sanitizedObjectKey, objectKey, {
      matchEtag: normalizeEtag(stagedStat?.etag),
    });

    const replacementStat = await objectStore.statObject(objectKey);
    verifyTrustedLegacyImageStat(replacementStat, {
      contentType,
      size: sanitizedBuffer.length,
    });
    await afterReplacement?.(replacementStat);
    return replacementStat;
  } catch (error) {
    const migrationError = error instanceof Error
      ? error
      : new Error(String(error || 'Legacy attachment replacement failed'));

    if (replacementAttempted && backupReady) {
      try {
        const backupStat = await objectStore.statObject(backupObjectKey);
        try {
          await objectStore.copyObject(backupObjectKey, objectKey, {
            matchEtag: normalizeEtag(backupStat?.etag),
          });
        } catch {
          // A failed response can arrive after MinIO completed the copy. The
          // authoritative post-copy stat below decides whether recovery worked.
        }
        const restoredStat = await objectStore.statObject(objectKey);
        verifyBackupStat(restoredStat, originalStat);
        migrationError.restorationAttempted = true;
        migrationError.restorationSucceeded = true;
      } catch (rollbackError) {
        const recoveryError = new Error(
          `Legacy attachment replacement failed and automatic restoration failed: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
          { cause: migrationError },
        );
        recoveryError.code = 'LEGACY_IMAGE_RESTORE_FAILED';
        recoveryError.rollbackError = rollbackError;
        recoveryError.restorationAttempted = true;
        recoveryError.restorationSucceeded = false;
        throw recoveryError;
      }
    }
    throw migrationError;
  } finally {
    await removeTemporaryObject(objectStore, sanitizedObjectKey);
    await removeTemporaryObject(objectStore, backupObjectKey);
  }
}

function createBaseReport(row) {
  return {
    attachment_id: String(row.id),
    conversation_id: String(row.conversation_id),
    object_key: String(row.object_key),
    created_at: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : (row.created_at ? String(row.created_at) : null),
    status: 'failed',
    old_content_type: null,
    new_content_type: null,
    old_size: null,
    new_size: null,
    width: null,
    height: null,
    marker_before: null,
    marker_after: null,
    descriptor_mime: null,
    descriptor_width: null,
    descriptor_height: null,
    descriptor_mime_mismatch: false,
    descriptor_dimension_mismatch: false,
    descriptor_updates: 0,
    restoration_attempted: false,
    restoration_succeeded: null,
    error_code: null,
    error_message: null,
  };
}

function classifyMigrationError(error) {
  const code = String(error?.code || error?.name || 'LEGACY_IMAGE_MIGRATION_FAILED');
  if (isMissingObjectError(error)) {
    return { status: 'object_missing', code };
  }
  if (
    code === 'ATTACHMENT_TOO_LARGE' ||
    code === 'ATTACHMENT_IMAGE_LIMIT_EXCEEDED'
  ) {
    return { status: 'exceeds_limits', code };
  }
  if (code === 'ATTACHMENT_IMAGE_UNSUPPORTED') {
    return { status: 'unsupported', code };
  }
  if (code === 'ATTACHMENT_IMAGE_INVALID') {
    return { status: 'corrupt', code };
  }
  if (
    code.startsWith('ATTACHMENT_SANITIZER_') ||
    code === 'ECONNREFUSED' ||
    code === 'ENOENT'
  ) {
    return { status: 'sanitizer_unavailable', code };
  }
  return { status: 'failed', code };
}

function pickCandidateDescriptor(references) {
  return references
    .map((reference) => reference.descriptor)
    .find(isLegacyImageCandidateDescriptor) || null;
}

function hasDimensionMismatch(references, width, height) {
  return references.some(({ descriptor }) => {
    const descriptorHasDimensions =
      Number.isFinite(descriptor?.width) ||
      Number.isFinite(descriptor?.height);
    return descriptorHasDimensions &&
      (descriptor.width !== width || descriptor.height !== height);
  });
}

export async function processLegacyImageCandidate(row, {
  apply,
  dependencies,
}) {
  const report = createBaseReport(row);

  try {
    const references = await dependencies.findDescriptorReferences(row);
    if (!Array.isArray(references) || references.length === 0) {
      report.status = 'descriptor_missing';
      return report;
    }

    const descriptor = pickCandidateDescriptor(references);
    if (!descriptor) {
      report.status = 'skipped_non_image';
      return report;
    }
    report.descriptor_mime = typeof descriptor.mime === 'string'
      ? descriptor.mime
      : null;
    report.descriptor_width = Number.isFinite(descriptor.width)
      ? descriptor.width
      : null;
    report.descriptor_height = Number.isFinite(descriptor.height)
      ? descriptor.height
      : null;

    let objectStat;
    try {
      objectStat = await dependencies.objectStore.statObject(row.object_key);
    } catch (error) {
      if (isMissingObjectError(error)) {
        report.status = 'object_missing';
        report.error_code = String(error?.code || error?.name || 'OBJECT_MISSING');
        report.error_message = 'Attachment object was not found';
        return report;
      }
      throw error;
    }

    report.old_content_type = getStoredContentType(objectStat) || null;
    report.old_size = Number.isSafeInteger(Number(objectStat?.size))
      ? Number(objectStat.size)
      : null;
    report.marker_before = getStoredAttachmentSanitizerMarker(objectStat) || null;

    if (report.marker_before === '1') {
      report.status = 'already_trusted';
      report.marker_after = '1';
      report.new_content_type = resolveStoredAttachmentPolicy(
        objectStat,
        row.object_key,
      ).contentType;
      report.new_size = report.old_size;
      return report;
    }

    if (
      !Number.isSafeInteger(report.old_size) ||
      report.old_size <= 0 ||
      report.old_size > MAX_CHAT_ATTACHMENT_BYTES
    ) {
      report.status = 'exceeds_limits';
      report.error_code = 'ATTACHMENT_TOO_LARGE';
      report.error_message = 'Legacy attachment exceeds the existing source byte limit';
      return report;
    }

    const source = await dependencies.objectStore.readObject(
      row.object_key,
      MAX_CHAT_ATTACHMENT_BYTES,
    );
    const claimedMime = typeof descriptor.mime === 'string' && descriptor.mime.trim()
      ? descriptor.mime.trim().slice(0, 255)
      : (report.old_content_type || 'application/octet-stream');
    const sanitizedImage = await dependencies.sanitizeImage(source, claimedMime);
    if (!sanitizedImage) {
      report.status = 'skipped_non_image';
      return report;
    }

    const originalName = typeof descriptor.name === 'string' && descriptor.name.trim()
      ? descriptor.name
      : (getStoredFilename(objectStat) || `${row.id}.bin`);
    const { policy, metadata } = buildTrustedLegacyImageMetadata({
      sanitizedImage,
      originalName,
    });

    report.new_content_type = policy.contentType;
    report.new_size = sanitizedImage.buffer.length;
    report.width = sanitizedImage.width;
    report.height = sanitizedImage.height;
    report.descriptor_mime_mismatch = Boolean(
      report.descriptor_mime &&
      report.descriptor_mime.split(';', 1)[0].trim().toLowerCase() !==
        policy.contentType,
    );
    report.descriptor_dimension_mismatch = hasDimensionMismatch(
      references,
      sanitizedImage.width,
      sanitizedImage.height,
    );

    if (!apply) {
      report.status = 'dry_run_candidate';
      return report;
    }

    let descriptorUpdates = 0;
    const replacementStat = await replaceLegacyObjectSafely({
      attachmentId: String(row.id),
      objectKey: String(row.object_key),
      originalStat: objectStat,
      sanitizedBuffer: sanitizedImage.buffer,
      metadata,
      contentType: policy.contentType,
      objectStore: dependencies.objectStore,
      afterReplacement: async () => {
        await dependencies.verifyDelivery?.(row, references[0]);
        if (report.descriptor_dimension_mismatch) {
          const updateResult = await dependencies.updateDescriptorDimensions(
            row,
            references,
            sanitizedImage.width,
            sanitizedImage.height,
          );
          descriptorUpdates = Number(updateResult?.updatedCount || 0);
        }
      },
    });

    report.status = 'migrated';
    report.marker_after = getStoredAttachmentSanitizerMarker(replacementStat) || null;
    report.descriptor_updates = descriptorUpdates;
    return report;
  } catch (error) {
    const classified = classifyMigrationError(error);
    report.status = classified.status;
    report.restoration_attempted = error?.restorationAttempted === true;
    report.restoration_succeeded = report.restoration_attempted
      ? error?.restorationSucceeded === true
      : null;
    report.error_code = classified.code;
    report.error_message = error instanceof Error
      ? error.message
      : String(error || 'Legacy attachment migration failed');

    if (classified.code === 'LEGACY_IMAGE_RESTORE_FAILED') {
      error.migrationRecord = report;
      throw error;
    }
    return report;
  }
}

export async function runLegacyImageMigration(rows, {
  apply = false,
  dependencies,
  onRecord,
} = {}) {
  if (!Array.isArray(rows)) {
    throw new TypeError('Legacy attachment rows must be an array');
  }
  if (!dependencies?.findDescriptorReferences) {
    throw new TypeError('findDescriptorReferences dependency is required');
  }
  if (!dependencies?.objectStore) {
    throw new TypeError('objectStore dependency is required');
  }
  if (!dependencies?.sanitizeImage) {
    throw new TypeError('sanitizeImage dependency is required');
  }
  if (apply && !dependencies?.updateDescriptorDimensions) {
    throw new TypeError('updateDescriptorDimensions dependency is required in apply mode');
  }

  const records = [];
  for (const row of rows) {
    let record;
    try {
      record = await processLegacyImageCandidate(row, {
        apply,
        dependencies,
      });
    } catch (error) {
      if (error?.migrationRecord) {
        records.push(error.migrationRecord);
        await onRecord?.(error.migrationRecord);
      }
      error.completedRecords = records;
      throw error;
    }
    records.push(record);
    await onRecord?.(record);
  }
  return records;
}

export function summarizeLegacyImageMigration(records) {
  const byStatus = {};
  records.forEach((record) => {
    byStatus[record.status] = (byStatus[record.status] || 0) + 1;
  });
  return {
    total: records.length,
    migrated: byStatus.migrated || 0,
    restored: records.filter((record) => record.restoration_succeeded === true).length,
    dry_run_candidates: byStatus.dry_run_candidate || 0,
    skipped:
      (byStatus.already_trusted || 0) +
      (byStatus.skipped_non_image || 0) +
      (byStatus.descriptor_missing || 0),
    failed:
      (byStatus.failed || 0) +
      (byStatus.unsupported || 0) +
      (byStatus.corrupt || 0) +
      (byStatus.exceeds_limits || 0) +
      (byStatus.sanitizer_unavailable || 0) +
      (byStatus.object_missing || 0),
    by_status: byStatus,
  };
}

export { MAX_CHAT_ATTACHMENT_BYTES };
