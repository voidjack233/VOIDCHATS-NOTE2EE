const DEFAULT_ATTACHMENT_FILENAME = 'attachment.bin';
const OCTET_STREAM_CONTENT_TYPE = 'application/octet-stream';
const INLINE_IMAGE_CONTENT_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
]);

export interface AttachmentStoragePolicy {
  inline: boolean;
  filename: string;
  contentType: string;
  contentDisposition: string;
}

interface SanitizedImageCandidate {
  buffer?: unknown;
  contentType?: unknown;
}

interface AttachmentStoragePolicyInput {
  sanitizedImage?: SanitizedImageCandidate | null;
  originalName?: unknown;
}

interface StoredObjectStat {
  metaData?: unknown;
}

function normalizeContentType(value: unknown): string {
  return typeof value === 'string'
    ? value.split(';', 1)[0].trim().toLowerCase()
    : '';
}

function getMetadataValue(metadata: unknown, names: readonly string[]): string {
  if (!metadata || typeof metadata !== 'object') return '';
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  const entry = Object.entries(metadata).find(([key]) => (
    normalizedNames.has(key.toLowerCase())
  ));
  return typeof entry?.[1] === 'string' ? entry[1] : '';
}

export function isInlineAttachmentImageContentType(value: unknown): boolean {
  return INLINE_IMAGE_CONTENT_TYPES.has(normalizeContentType(value));
}

export function sanitizeAttachmentFilename(
  value: unknown,
  fallback: string = DEFAULT_ATTACHMENT_FILENAME,
): string {
  const finalSegment = String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.normalize('NFKC') || '';
  const safe = finalSegment
    .replace(/[\u0000-\u001f\u007f-\u009f"\\]/g, '_')
    .replace(/[^\x20-\x7e]/g, '_')
    .trim()
    .replace(/^\.+$/, '')
    .slice(0, 180);

  return safe || fallback;
}

export function createAttachmentContentDisposition(
  filename: unknown,
  inline: boolean,
): string {
  const safeFilename = sanitizeAttachmentFilename(filename);
  return `${inline ? 'inline' : 'attachment'}; filename="${safeFilename}"`;
}

export function createAttachmentStoragePolicy({
  sanitizedImage,
  originalName,
}: AttachmentStoragePolicyInput): Readonly<AttachmentStoragePolicy> {
  const inline = Boolean(
    sanitizedImage &&
    Buffer.isBuffer(sanitizedImage.buffer) &&
    isInlineAttachmentImageContentType(sanitizedImage.contentType),
  );
  const sanitizedContentType = sanitizedImage?.contentType;
  const filename = sanitizeAttachmentFilename(originalName);
  const contentType = inline
    ? normalizeContentType(sanitizedContentType)
    : OCTET_STREAM_CONTENT_TYPE;

  return Object.freeze({
    inline,
    filename,
    contentType,
    contentDisposition: createAttachmentContentDisposition(filename, inline),
  });
}

export function createAttachmentObjectMetadata(
  policy: AttachmentStoragePolicy,
): Record<string, string> {
  return {
    'Content-Type': policy.contentType,
    'Content-Disposition': policy.contentDisposition,
    'X-Amz-Meta-Void-Sanitized-Image': policy.inline ? '1' : '0',
    'X-Amz-Meta-Original-Filename': policy.filename,
  };
}

export function createAttachmentBlobMetadata(
  policy: AttachmentStoragePolicy,
): Record<string, string> {
  return {
    'Content-Type': policy.contentType,
    'Content-Disposition': createAttachmentContentDisposition(
      DEFAULT_ATTACHMENT_FILENAME,
      policy.inline,
    ),
    'X-Amz-Meta-Void-Sanitized-Image': policy.inline ? '1' : '0',
  };
}

export function getStoredAttachmentSanitizerMarker(
  objectStat: StoredObjectStat | null | undefined,
): string {
  return getMetadataValue(objectStat?.metaData, [
    'void-sanitized-image',
    'x-amz-meta-void-sanitized-image',
  ]);
}

export function resolveStoredAttachmentPolicy(
  objectStat: StoredObjectStat | null | undefined,
  objectKey: unknown = '',
  logicalFilename: unknown = '',
): AttachmentStoragePolicy {
  const metadata = objectStat?.metaData || {};
  const storedContentType = getMetadataValue(metadata, ['content-type']);
  const inlineMarker = getStoredAttachmentSanitizerMarker(objectStat);
  const storedFilename = getMetadataValue(metadata, [
    'original-filename',
    'x-amz-meta-original-filename',
  ]);
  const fallbackFilename = String(objectKey || '').split('/').pop();

  const videoMarker = getMetadataValue(metadata, ['void-sanitized-video', 'x-amz-meta-void-sanitized-video']);
  const inline = (inlineMarker === '1' && isInlineAttachmentImageContentType(storedContentType)) ||
    (videoMarker === '1' && normalizeContentType(storedContentType) === 'video/mp4');
  const filename = sanitizeAttachmentFilename(
    logicalFilename || storedFilename || fallbackFilename,
  );
  const contentType = inline
    ? normalizeContentType(storedContentType)
    : OCTET_STREAM_CONTENT_TYPE;

  return {
    inline,
    filename,
    contentType,
    contentDisposition: createAttachmentContentDisposition(filename, inline),
  };
}

export function createProtectedAttachmentResponseHeaders(
  objectStat: StoredObjectStat | null | undefined,
  objectKey: unknown = '',
  logicalFilename: unknown = '',
): Record<string, string> {
  const policy = resolveStoredAttachmentPolicy(objectStat, objectKey, logicalFilename);
  return {
    'Content-Type': policy.contentType,
    'Content-Disposition': policy.contentDisposition,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  };
}

export function createPresignedAttachmentResponseParams(
  objectStat: StoredObjectStat | null | undefined,
  objectKey: unknown = '',
  logicalFilename: unknown = '',
): Record<string, string> {
  const policy = resolveStoredAttachmentPolicy(objectStat, objectKey, logicalFilename);
  return {
    'response-cache-control': 'private, no-store',
    'response-content-type': policy.contentType,
    'response-content-disposition': policy.contentDisposition,
  };
}

export { OCTET_STREAM_CONTENT_TYPE };
