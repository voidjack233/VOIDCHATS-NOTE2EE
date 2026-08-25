import { randomUUID } from 'node:crypto';

import {
  createAttachmentObjectMetadata,
  createAttachmentStoragePolicy,
  getStoredAttachmentSanitizerMarker,
  resolveStoredAttachmentPolicy,
} from '../../server/utils/attachmentContentPolicy.js';
import type { AttachmentStoragePolicy } from '../../server/utils/attachmentContentPolicy.js';
import type { SanitizedChatAttachmentImage } from '../../server/utils/chatImageSanitizer.js';
import { MAX_CHAT_ATTACHMENT_BYTES } from '../../server/utils/chatImageLimits.js';

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, 'i');
const ATTACHMENT_PATH_PATTERN = new RegExp(`/attachments/(${UUID_SOURCE})(?:/)?$`, 'i');
const IMAGE_FILENAME_PATTERN = /\.(avif|bmp|gif|jpe?g|png|svg|tiff?|webp)$/i;

export interface LegacyAttachmentDescriptor {
  [key: string]: unknown;
  id?: unknown;
  url?: unknown;
  mime?: unknown;
  name?: unknown;
  width?: unknown;
  height?: unknown;
}

export interface LegacyObjectStat {
  metaData?: unknown;
  size?: unknown;
  etag?: unknown;
}

export interface LegacyAttachmentRow {
  id: string;
  conversation_id: string;
  uploader_id?: string;
  bucket?: string;
  object_key: string;
  created_at?: Date | string | null;
}

export interface LegacyMessageRecord {
  storageConversationId: string;
  messageId: string;
  attachments: unknown[];
}

export interface LegacyDescriptorReference {
  descriptor: LegacyAttachmentDescriptor;
  index: number;
  messageRecord: LegacyMessageRecord;
}

export interface LegacyObjectStore {
  statObject(objectKey: string): Promise<LegacyObjectStat>;
  readObject(objectKey: string, maxBytes: number): Promise<Buffer>;
  putObject(
    objectKey: string,
    buffer: Buffer,
    metadata: Record<string, string>,
  ): Promise<unknown>;
  copyObject(
    sourceObjectKey: string,
    destinationObjectKey: string,
    options?: { matchEtag?: string },
  ): Promise<unknown>;
  removeObject(objectKey: string): Promise<unknown>;
}

export interface LegacyMigrationDependencies {
  findDescriptorReferences(
    row: LegacyAttachmentRow,
  ): Promise<LegacyDescriptorReference[]>;
  objectStore: LegacyObjectStore;
  sanitizeImage(
    source: Buffer,
    claimedMime: string,
  ): Promise<SanitizedChatAttachmentImage | null>;
  updateDescriptorDimensions(
    row: LegacyAttachmentRow,
    references: LegacyDescriptorReference[],
    width: number,
    height: number,
  ): Promise<{ updatedCount?: number }>;
  verifyDelivery?(
    row: LegacyAttachmentRow,
    reference: LegacyDescriptorReference,
  ): Promise<void>;
}

export type LegacyMigrationStatus =
  | 'failed'
  | 'object_missing'
  | 'exceeds_limits'
  | 'unsupported'
  | 'corrupt'
  | 'sanitizer_unavailable'
  | 'descriptor_missing'
  | 'skipped_non_image'
  | 'already_trusted'
  | 'dry_run_candidate'
  | 'migrated';

export interface LegacyMigrationRecord {
  attachment_id: string;
  conversation_id: string;
  object_key: string;
  created_at: string | null;
  status: LegacyMigrationStatus;
  old_content_type: string | null;
  new_content_type: string | null;
  old_size: number | null;
  new_size: number | null;
  width: number | null;
  height: number | null;
  marker_before: string | null;
  marker_after: string | null;
  descriptor_mime: string | null;
  descriptor_width: number | null;
  descriptor_height: number | null;
  descriptor_mime_mismatch: boolean;
  descriptor_dimension_mismatch: boolean;
  descriptor_updates: number;
  restoration_attempted: boolean;
  restoration_succeeded: boolean | null;
  error_code: string | null;
  error_message: string | null;
}

interface ReplaceLegacyObjectInput {
  attachmentId: string;
  objectKey: string;
  originalStat: LegacyObjectStat;
  sanitizedBuffer: Buffer;
  metadata: Record<string, string>;
  contentType: string;
  objectStore: LegacyObjectStore;
  afterReplacement?: (replacementStat: LegacyObjectStat) => Promise<void> | void;
}

interface ProcessLegacyImageOptions {
  apply: boolean;
  dependencies: LegacyMigrationDependencies;
}

interface RunLegacyImageOptions {
  apply?: boolean;
  dependencies?: Partial<LegacyMigrationDependencies>;
  onRecord?: (record: LegacyMigrationRecord) => Promise<void> | void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getErrorProperty(error: unknown, property: string): unknown {
  return error !== null && typeof error === 'object'
    ? Reflect.get(error, property)
    : undefined;
}

function setErrorProperty(error: Error, property: string, value: unknown): void {
  Reflect.set(error, property, value);
}

function getErrorCode(error: unknown, fallback = ''): string {
  return String(
    getErrorProperty(error, 'code') ||
    getErrorProperty(error, 'name') ||
    fallback,
  );
}

function finiteStoredNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getMetadataValue(
  objectStat: LegacyObjectStat | null | undefined,
  names: readonly string[],
): string {
  const metadata = objectStat?.metaData;
  if (!metadata || typeof metadata !== 'object') return '';

  const expectedNames = new Set(names.map((name) => name.toLowerCase()));
  const entry = Object.entries(metadata).find(([name]) => (
    expectedNames.has(name.toLowerCase())
  ));
  return entry?.[1] == null ? '' : String(entry[1]);
}

function getStoredContentType(objectStat: LegacyObjectStat): string {
  return getMetadataValue(objectStat, ['content-type']);
}

function getStoredFilename(objectStat: LegacyObjectStat): string {
  return getMetadataValue(objectStat, [
    'original-filename',
    'x-amz-meta-original-filename',
  ]);
}

function normalizeEtag(value: unknown): string {
  return typeof value === 'string' ? value.replaceAll('"', '').trim() : '';
}

function isMissingObjectError(error: unknown): boolean {
  const code = getErrorCode(error);
  return ['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(code);
}

export function parseLegacyAttachmentDescriptor(
  rawAttachment: unknown,
): LegacyAttachmentDescriptor | null {
  if (typeof rawAttachment !== 'string' || rawAttachment.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawAttachment);
    if (isRecord(parsed) && typeof parsed.url === 'string') {
      return { ...parsed };
    }
  } catch {
    // Legacy message rows may store only the protected attachment URL.
  }

  return { url: rawAttachment };
}

export function getLegacyDescriptorAttachmentId(
  descriptor: LegacyAttachmentDescriptor | null | undefined,
): string | null {
  const descriptorId = descriptor?.id;
  if (UUID_PATTERN.test(String(descriptorId || ''))) {
    return String(descriptorId).toLowerCase();
  }

  if (typeof descriptor?.url !== 'string') return null;
  try {
    const parsed = new URL(descriptor.url, 'https://attachment.invalid');
    return parsed.pathname.match(ATTACHMENT_PATH_PATTERN)?.[1]?.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function isLegacyImageCandidateDescriptor(
  descriptor: LegacyAttachmentDescriptor | null | undefined,
): boolean {
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
}: {
  sanitizedImage: SanitizedChatAttachmentImage;
  originalName: string;
}): {
  policy: Readonly<AttachmentStoragePolicy>;
  metadata: Record<string, string>;
} {
  const policy = createAttachmentStoragePolicy({
    sanitizedImage,
    originalName,
  });
  if (!policy.inline) {
    const error = new Error('Sanitizer output did not produce a trusted inline image');
    setErrorProperty(error, 'code', 'LEGACY_IMAGE_POLICY_REJECTED');
    throw error;
  }

  return {
    policy,
    metadata: createAttachmentObjectMetadata(policy),
  };
}

export function verifyTrustedLegacyImageStat(objectStat: LegacyObjectStat, {
  contentType,
  size,
}: {
  contentType: string;
  size: number;
}): AttachmentStoragePolicy {
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
    setErrorProperty(error, 'code', 'LEGACY_IMAGE_REPLACEMENT_VERIFICATION_FAILED');
    throw error;
  }

  return policy;
}

function verifyBackupStat(
  backupStat: LegacyObjectStat,
  originalStat: LegacyObjectStat,
): void {
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
    setErrorProperty(error, 'code', 'LEGACY_IMAGE_BACKUP_VERIFICATION_FAILED');
    throw error;
  }
}

async function removeTemporaryObject(
  objectStore: LegacyObjectStore,
  objectKey: string,
): Promise<void> {
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
}: ReplaceLegacyObjectInput): Promise<LegacyObjectStat> {
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
        setErrorProperty(migrationError, 'restorationAttempted', true);
        setErrorProperty(migrationError, 'restorationSucceeded', true);
      } catch (rollbackError) {
        const recoveryError = new Error(
          `Legacy attachment replacement failed and automatic restoration failed: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
          { cause: migrationError },
        );
        setErrorProperty(recoveryError, 'code', 'LEGACY_IMAGE_RESTORE_FAILED');
        setErrorProperty(recoveryError, 'rollbackError', rollbackError);
        setErrorProperty(recoveryError, 'restorationAttempted', true);
        setErrorProperty(recoveryError, 'restorationSucceeded', false);
        throw recoveryError;
      }
    }
    throw migrationError;
  } finally {
    await removeTemporaryObject(objectStore, sanitizedObjectKey);
    await removeTemporaryObject(objectStore, backupObjectKey);
  }
}

function createBaseReport(row: LegacyAttachmentRow): LegacyMigrationRecord {
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

function classifyMigrationError(error: unknown): {
  status: LegacyMigrationStatus;
  code: string;
} {
  const code = getErrorCode(error, 'LEGACY_IMAGE_MIGRATION_FAILED');
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

function pickCandidateDescriptor(
  references: LegacyDescriptorReference[],
): LegacyAttachmentDescriptor | null {
  return references
    .map((reference) => reference.descriptor)
    .find(isLegacyImageCandidateDescriptor) || null;
}

function hasDimensionMismatch(
  references: LegacyDescriptorReference[],
  width: number,
  height: number,
): boolean {
  return references.some(({ descriptor }) => {
    const descriptorHasDimensions =
      Number.isFinite(descriptor?.width) ||
      Number.isFinite(descriptor?.height);
    return descriptorHasDimensions &&
      (descriptor.width !== width || descriptor.height !== height);
  });
}

export async function processLegacyImageCandidate(row: LegacyAttachmentRow, {
  apply,
  dependencies,
}: ProcessLegacyImageOptions): Promise<LegacyMigrationRecord> {
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
    report.descriptor_width = finiteStoredNumber(descriptor.width);
    report.descriptor_height = finiteStoredNumber(descriptor.height);

    let objectStat: LegacyObjectStat;
    try {
      objectStat = await dependencies.objectStore.statObject(row.object_key);
    } catch (error) {
      if (isMissingObjectError(error)) {
        report.status = 'object_missing';
        report.error_code = getErrorCode(error, 'OBJECT_MISSING');
        report.error_message = 'Attachment object was not found';
        return report;
      }
      throw error;
    }

    report.old_content_type = getStoredContentType(objectStat) || null;
    const oldSize = Number.isSafeInteger(Number(objectStat?.size))
      ? Number(objectStat.size)
      : null;
    report.old_size = oldSize;
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
      oldSize === null ||
      oldSize <= 0 ||
      oldSize > MAX_CHAT_ATTACHMENT_BYTES
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
    report.restoration_attempted = getErrorProperty(error, 'restorationAttempted') === true;
    report.restoration_succeeded = report.restoration_attempted
      ? getErrorProperty(error, 'restorationSucceeded') === true
      : null;
    report.error_code = classified.code;
    report.error_message = error instanceof Error
      ? error.message
      : String(error || 'Legacy attachment migration failed');

    if (classified.code === 'LEGACY_IMAGE_RESTORE_FAILED') {
      const migrationError = error instanceof Error
        ? error
        : new Error(String(error || 'Legacy attachment migration failed'));
      setErrorProperty(migrationError, 'migrationRecord', report);
      throw migrationError;
    }
    return report;
  }
}

export async function runLegacyImageMigration(rows: LegacyAttachmentRow[], {
  apply = false,
  dependencies,
  onRecord,
}: RunLegacyImageOptions = {}): Promise<LegacyMigrationRecord[]> {
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

  const resolvedDependencies: LegacyMigrationDependencies = {
    findDescriptorReferences: dependencies.findDescriptorReferences,
    objectStore: dependencies.objectStore,
    sanitizeImage: dependencies.sanitizeImage,
    updateDescriptorDimensions: dependencies.updateDescriptorDimensions || (async () => ({
      updatedCount: 0,
    })),
    ...(dependencies.verifyDelivery
      ? { verifyDelivery: dependencies.verifyDelivery }
      : {}),
  };

  const records: LegacyMigrationRecord[] = [];
  for (const row of rows) {
    let record;
    try {
      record = await processLegacyImageCandidate(row, {
        apply,
        dependencies: resolvedDependencies,
      });
    } catch (error) {
      const migrationRecord = getErrorProperty(error, 'migrationRecord');
      if (isLegacyMigrationRecord(migrationRecord)) {
        records.push(migrationRecord);
        await onRecord?.(migrationRecord);
      }
      const migrationError = error instanceof Error
        ? error
        : new Error(String(error || 'Legacy attachment migration failed'));
      setErrorProperty(migrationError, 'completedRecords', records);
      throw migrationError;
    }
    records.push(record);
    await onRecord?.(record);
  }
  return records;
}

function isLegacyMigrationRecord(value: unknown): value is LegacyMigrationRecord {
  return isRecord(value) &&
    typeof value.attachment_id === 'string' &&
    typeof value.status === 'string';
}

export function summarizeLegacyImageMigration(records: LegacyMigrationRecord[]): {
  total: number;
  migrated: number;
  restored: number;
  dry_run_candidates: number;
  skipped: number;
  failed: number;
  by_status: Record<string, number>;
} {
  const byStatus: Record<string, number> = {};
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
