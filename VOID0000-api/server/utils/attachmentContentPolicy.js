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

function normalizeContentType(value) {
  return typeof value === 'string'
    ? value.split(';', 1)[0].trim().toLowerCase()
    : '';
}

function getMetadataValue(metadata, names) {
  if (!metadata || typeof metadata !== 'object') return '';
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  const entry = Object.entries(metadata).find(([key]) => (
    normalizedNames.has(key.toLowerCase())
  ));
  return typeof entry?.[1] === 'string' ? entry[1] : '';
}

export function isInlineAttachmentImageContentType(value) {
  return INLINE_IMAGE_CONTENT_TYPES.has(normalizeContentType(value));
}

export function sanitizeAttachmentFilename(value, fallback = DEFAULT_ATTACHMENT_FILENAME) {
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

export function createAttachmentContentDisposition(filename, inline) {
  const safeFilename = sanitizeAttachmentFilename(filename);
  return `${inline ? 'inline' : 'attachment'}; filename="${safeFilename}"`;
}

export function createAttachmentStoragePolicy({ sanitizedImage, originalName }) {
  const inline = Boolean(
    sanitizedImage &&
    Buffer.isBuffer(sanitizedImage.buffer) &&
    isInlineAttachmentImageContentType(sanitizedImage.contentType),
  );
  const filename = sanitizeAttachmentFilename(originalName);
  const contentType = inline
    ? normalizeContentType(sanitizedImage.contentType)
    : OCTET_STREAM_CONTENT_TYPE;

  return Object.freeze({
    inline,
    filename,
    contentType,
    contentDisposition: createAttachmentContentDisposition(filename, inline),
  });
}

export function createAttachmentObjectMetadata(policy) {
  return {
    'Content-Type': policy.contentType,
    'Content-Disposition': policy.contentDisposition,
    'X-Amz-Meta-Void-Sanitized-Image': policy.inline ? '1' : '0',
    'X-Amz-Meta-Original-Filename': policy.filename,
  };
}

export function resolveStoredAttachmentPolicy(objectStat, objectKey = '') {
  const metadata = objectStat?.metaData || {};
  const storedContentType = getMetadataValue(metadata, ['content-type']);
  const inlineMarker = getMetadataValue(metadata, [
    'void-sanitized-image',
    'x-amz-meta-void-sanitized-image',
  ]);
  const storedFilename = getMetadataValue(metadata, [
    'original-filename',
    'x-amz-meta-original-filename',
  ]);
  const fallbackFilename = String(objectKey || '').split('/').pop();

  // Existing sanitized raster objects predate the marker. Restricting their
  // response MIME to this fixed raster allowlist remains non-executable.
  const inline = inlineMarker !== '0' &&
    isInlineAttachmentImageContentType(storedContentType);
  const filename = sanitizeAttachmentFilename(storedFilename || fallbackFilename);
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

export function createPresignedAttachmentResponseParams(objectStat, objectKey = '') {
  const policy = resolveStoredAttachmentPolicy(objectStat, objectKey);
  return {
    'response-cache-control': 'private, no-store',
    'response-content-type': policy.contentType,
    'response-content-disposition': policy.contentDisposition,
  };
}

export { OCTET_STREAM_CONTENT_TYPE };
