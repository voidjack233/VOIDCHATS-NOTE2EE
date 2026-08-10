export const MAX_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_STATIC_IMAGE_PIXELS = 25_000_000;
export const NORMALIZED_STATIC_IMAGE_TARGET_PIXELS = 12_000_000;
export const NORMALIZED_STATIC_IMAGE_MAX_EDGE = 4_096;

export type SupportedAttachmentImageMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';

interface AttachmentFileIdentity {
  name?: string;
  type?: string;
}

interface ImageNormalizationPlan {
  required: boolean;
  width: number;
  height: number;
}

const SUPPORTED_IMAGE_MIMES = new Map<string, SupportedAttachmentImageMime>([
  ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/png', 'image/png'],
  ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'],
]);

const IMAGE_MIME_BY_EXTENSION = new Map<string, SupportedAttachmentImageMime>([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);

const HEIC_MIMES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

export class AttachmentPreparationError extends Error {
  code: string;
  status: number;
  statusCode: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'AttachmentPreparationError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function normalizeMime(value?: string): string {
  return typeof value === 'string'
    ? value.split(';', 1)[0]!.trim().toLowerCase()
    : '';
}

function getExtension(filename?: string): string {
  const match = typeof filename === 'string'
    ? filename.trim().toLowerCase().match(/\.([a-z0-9]+)$/)
    : null;
  return match?.[1] || '';
}

export function resolveSupportedAttachmentImageMime(
  file: AttachmentFileIdentity,
): SupportedAttachmentImageMime | null {
  const mime = normalizeMime(file.type);
  const supportedMime = SUPPORTED_IMAGE_MIMES.get(mime);
  if (supportedMime) return supportedMime;
  if (mime && mime !== 'application/octet-stream') return null;
  return IMAGE_MIME_BY_EXTENSION.get(getExtension(file.name)) || null;
}

export function isUnconvertedHeicHeif(file: AttachmentFileIdentity): boolean {
  const mime = normalizeMime(file.type);
  if (HEIC_MIMES.has(mime)) return true;
  if (SUPPORTED_IMAGE_MIMES.has(mime)) return false;
  return ['heic', 'heif'].includes(getExtension(file.name));
}

export function isImageLikeAttachment(file: AttachmentFileIdentity): boolean {
  const mime = normalizeMime(file.type);
  return mime.startsWith('image/') ||
    Boolean(IMAGE_MIME_BY_EXTENSION.get(getExtension(file.name))) ||
    isUnconvertedHeicHeif(file);
}

export function getStaticImageNormalizationPlan(
  width: number,
  height: number,
): ImageNormalizationPlan {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new AttachmentPreparationError(
      'Selected image has invalid dimensions',
      'ATTACHMENT_IMAGE_INVALID',
      400,
    );
  }

  const pixels = width * height;
  if (pixels <= MAX_STATIC_IMAGE_PIXELS) {
    return { required: false, width, height };
  }

  const scale = Math.min(
    1,
    Math.sqrt(NORMALIZED_STATIC_IMAGE_TARGET_PIXELS / pixels),
    NORMALIZED_STATIC_IMAGE_MAX_EDGE / width,
    NORMALIZED_STATIC_IMAGE_MAX_EDGE / height,
  );
  return {
    required: true,
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

export function getAttachmentUploadErrorLabel(error: unknown): string {
  const payload = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  const code = typeof payload.code === 'string' ? payload.code : '';
  const status = Number(payload.status ?? payload.statusCode);
  const message = typeof payload.message === 'string' ? payload.message.toLowerCase() : '';

  if (code === 'ATTACHMENT_HEIC_UNSUPPORTED') {
    return 'HEIC/HEIF images are not supported here. Choose the photo through Media or convert it to JPEG/PNG.';
  }
  if (code === 'ATTACHMENT_IMAGE_LIMIT_EXCEEDED') return 'Image resolution is too large';
  if (code === 'ATTACHMENT_IMAGE_UNSUPPORTED') return 'Image format is not supported';
  if (code === 'ATTACHMENT_IMAGE_INVALID') return 'Image is invalid or corrupted';
  if (code === 'ATTACHMENT_IMAGE_SANITIZATION_FAILED') return 'Image could not be processed safely';
  if (code === 'ATTACHMENT_TOO_LARGE') return 'Attachment exceeds the 10 MiB limit';
  if (code === 'ATTACHMENT_METADATA_INVALID' || code === 'ATTACHMENT_METADATA_TOO_LARGE') {
    return 'Attachment metadata is invalid';
  }
  if (code === 'ATTACHMENT_STAGED_QUOTA_EXCEEDED') return 'Too many unsent attachments';
  if (code === 'ATTACHMENT_UPLOAD_RATE_LIMITED' || status === 429) return 'Upload limit reached';
  if (code === 'REQUEST_TIMEOUT' || payload.name === 'AbortError' || message.includes('timed out')) {
    return 'Upload timed out';
  }
  if (status >= 500) return 'Service unavailable';
  if (message.includes('failed to fetch') || message.includes('network')) return 'Waiting for network';
  if (status === 413) return 'Attachment exceeds upload or image processing limits';
  if (status === 415) return 'Attachment format is not supported';
  return 'Upload failed';
}
