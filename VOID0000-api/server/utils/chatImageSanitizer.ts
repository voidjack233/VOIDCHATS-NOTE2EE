import sharp from 'sharp';
import { ChatImageSanitizationError } from './chatImageErrors.js';
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_IMAGE_ANIMATED_FRAME_PIXELS,
  MAX_CHAT_IMAGE_ANIMATED_TOTAL_PIXELS,
  MAX_CHAT_IMAGE_ANIMATION_FRAMES,
  MAX_CHAT_IMAGE_STATIC_PIXELS,
} from './chatImageLimits.js';

export { ChatImageSanitizationError } from './chatImageErrors.js';
export {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_IMAGE_ANIMATED_FRAME_PIXELS,
  MAX_CHAT_IMAGE_ANIMATED_TOTAL_PIXELS,
  MAX_CHAT_IMAGE_ANIMATION_FRAMES,
  MAX_CHAT_IMAGE_STATIC_PIXELS,
} from './chatImageLimits.js';

type SharpInstance = ReturnType<typeof sharp>;
type SharpMetadata = Awaited<ReturnType<SharpInstance['metadata']>>;
type SharpInputOptions = NonNullable<Parameters<typeof sharp>[1]>;
export type ChatImageFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'tiff' | 'avif';

type ImageGeometry = {
  width: number;
  height: number;
  pages: number;
  framePixels: number;
  totalPixels: number;
  animated: boolean;
};

export type SanitizedChatAttachmentImage = {
  buffer: Buffer;
  contentType: string;
  width: number;
  height: number;
  pages: number;
  animated: boolean;
  sourceFormat: ChatImageFormat;
};

const ANIMATED_FORMATS: ReadonlySet<string> = new Set(['gif', 'webp']);
const CONTENT_TYPES = Object.freeze({
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  tiff: 'image/tiff',
  avif: 'image/avif',
});
const INPUT_OPTIONS: Readonly<SharpInputOptions> = Object.freeze({
  animated: true,
  failOn: 'warning',
  limitInputPixels: MAX_CHAT_IMAGE_ANIMATED_TOTAL_PIXELS,
  sequentialRead: true,
});

function invalidImageError(): ChatImageSanitizationError {
  return new ChatImageSanitizationError('Attachment is not a valid image', {
    code: 'ATTACHMENT_IMAGE_INVALID',
    status: 400,
  });
}

function unsupportedImageError(): ChatImageSanitizationError {
  return new ChatImageSanitizationError('Attachment image format is not supported', {
    code: 'ATTACHMENT_IMAGE_UNSUPPORTED',
    status: 415,
  });
}

function imageLimitError(): ChatImageSanitizationError {
  return new ChatImageSanitizationError('Attachment image exceeds processing safety limits', {
    code: 'ATTACHMENT_IMAGE_LIMIT_EXCEEDED',
    status: 413,
  });
}

function sanitizationFailedError(): ChatImageSanitizationError {
  return new ChatImageSanitizationError('Attachment image could not be sanitized safely', {
    code: 'ATTACHMENT_IMAGE_SANITIZATION_FAILED',
    status: 422,
  });
}

function normalizeClaimedMime(value: unknown): string {
  return typeof value === 'string'
    ? value.split(';', 1)[0].trim().toLowerCase()
    : '';
}

function isPixelLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /pixel limit|too many pixels|exceeds.*pixels|memory allocation/i.test(
    message,
  );
}

function isLikelySvg(source: Buffer): boolean {
  const prefix = source
    .subarray(0, Math.min(source.length, 1024))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  return prefix.startsWith('<svg') ||
    (prefix.startsWith('<?xml') && /<svg[\s>]/.test(prefix));
}

function hasRecognizedImageSignature(source: Buffer): boolean {
  if (source.length < 4) return false;

  const jpeg = source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff;
  const png = source.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const gif = source.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    source.subarray(0, 6).toString('ascii') === 'GIF89a';
  const webp = source.subarray(0, 4).toString('ascii') === 'RIFF' &&
    source.subarray(8, 12).toString('ascii') === 'WEBP';
  const tiff = (
    source[0] === 0x49 && source[1] === 0x49 && source[2] === 0x2a && source[3] === 0x00
  ) || (
    source[0] === 0x4d && source[1] === 0x4d && source[2] === 0x00 && source[3] === 0x2a
  );
  const isoBmff = source.subarray(4, 8).toString('ascii') === 'ftyp';
  const avif = isoBmff && ['avif', 'avis'].some((brand) => (
    source.subarray(8, Math.min(source.length, 40)).includes(Buffer.from(brand))
  ));
  const bmp = source[0] === 0x42 && source[1] === 0x4d;
  const ico = source[0] === 0x00 && source[1] === 0x00 &&
    source[2] === 0x01 && source[3] === 0x00;

  return jpeg || png || gif || webp || tiff || avif || bmp || ico || isLikelySvg(source);
}

function resolveSourceFormat(metadata: SharpMetadata): ChatImageFormat | null {
  if (
    metadata.format === 'jpeg' ||
    metadata.format === 'png' ||
    metadata.format === 'webp' ||
    metadata.format === 'gif' ||
    metadata.format === 'tiff'
  ) {
    return metadata.format;
  }
  if (metadata.format === 'heif' && metadata.compression === 'av1') {
    return 'avif';
  }
  return null;
}

function getImageGeometry(metadata: SharpMetadata): ImageGeometry {
  const pages = metadata.pages || 1;
  const frameHeight = metadata.pageHeight || metadata.height;
  const width = Number(metadata.width);
  const height = Number(frameHeight);
  const framePixels = width * height;
  const totalPixels = framePixels * pages;

  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(pages) ||
    width <= 0 ||
    height <= 0 ||
    pages <= 0 ||
    !Number.isSafeInteger(framePixels) ||
    !Number.isSafeInteger(totalPixels)
  ) {
    throw invalidImageError();
  }

  return {
    width,
    height,
    pages,
    framePixels,
    totalPixels,
    animated: pages > 1,
  };
}

function assertWithinImageLimits(
  format: ChatImageFormat,
  geometry: ImageGeometry,
): void {
  if (geometry.animated && !ANIMATED_FORMATS.has(format)) {
    throw unsupportedImageError();
  }
  if (
    (!geometry.animated && geometry.framePixels > MAX_CHAT_IMAGE_STATIC_PIXELS) ||
    (geometry.animated && (
      geometry.pages > MAX_CHAT_IMAGE_ANIMATION_FRAMES ||
      geometry.framePixels > MAX_CHAT_IMAGE_ANIMATED_FRAME_PIXELS ||
      geometry.totalPixels > MAX_CHAT_IMAGE_ANIMATED_TOTAL_PIXELS
    ))
  ) {
    throw imageLimitError();
  }
}

function applyOutputFormat(
  pipeline: SharpInstance,
  format: ChatImageFormat,
  metadata: SharpMetadata,
  animated: boolean,
): SharpInstance {
  if (format === 'jpeg') {
    return pipeline.jpeg({
      quality: 95,
      chromaSubsampling: '4:4:4',
      optimiseCoding: true,
    });
  }
  if (format === 'png') {
    return pipeline.png({
      compressionLevel: 9,
      adaptiveFiltering: true,
    });
  }
  if (format === 'webp') {
    return pipeline.webp({
      quality: 95,
      alphaQuality: 100,
      effort: animated ? 3 : 4,
      smartSubsample: true,
      ...(animated ? {
        loop: metadata.loop ?? 0,
        delay: metadata.delay,
      } : {}),
    });
  }
  if (format === 'gif') {
    return pipeline.gif({
      effort: 7,
      keepDuplicateFrames: true,
      reuse: true,
      loop: metadata.loop ?? 0,
      delay: metadata.delay,
    });
  }
  if (format === 'tiff') {
    return pipeline.tiff({
      compression: 'lzw',
      quality: 95,
    });
  }
  if (format === 'avif') {
    return pipeline.avif({
      quality: 90,
      effort: 4,
      chromaSubsampling: '4:4:4',
    });
  }
  throw unsupportedImageError();
}

function hasSensitiveMetadata(metadata: SharpMetadata): boolean {
  return Boolean(
    (metadata.orientation && metadata.orientation !== 1) ||
    metadata.exif ||
    metadata.icc ||
    metadata.iptc ||
    metadata.xmp ||
    (Array.isArray(metadata.comments) && metadata.comments.length > 0) ||
    metadata.hasProfile
  );
}

/**
 * Returns null for ordinary non-image data. Actual or claimed images either
 * return a sanitized re-encoding or fail closed with ChatImageSanitizationError.
 */
export async function sanitizeChatAttachmentImage(
  source: unknown,
  claimedMime: unknown,
): Promise<SanitizedChatAttachmentImage | null> {
  if (!Buffer.isBuffer(source) || source.length === 0) {
    throw invalidImageError();
  }
  if (source.length > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new ChatImageSanitizationError(
      'File too large. Maximum 10MB per attachment.',
      { code: 'ATTACHMENT_TOO_LARGE', status: 413 },
    );
  }

  const claimedImage = normalizeClaimedMime(claimedMime).startsWith('image/');
  const recognizedImage = hasRecognizedImageSignature(source);
  if (isLikelySvg(source)) {
    throw unsupportedImageError();
  }
  let metadata;

  try {
    metadata = await sharp(source, INPUT_OPTIONS).metadata();
  } catch (error) {
    if (isPixelLimitError(error)) throw imageLimitError();
    if (claimedImage || recognizedImage) throw invalidImageError();
    return null;
  }

  const format = resolveSourceFormat(metadata);
  if (!format) {
    throw unsupportedImageError();
  }

  const geometry = getImageGeometry(metadata);
  assertWithinImageLimits(format, geometry);

  let output;
  try {
    const pipeline = sharp(source, INPUT_OPTIONS).rotate();
    output = await applyOutputFormat(pipeline, format, metadata, geometry.animated)
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error instanceof ChatImageSanitizationError) throw error;
    if (isPixelLimitError(error)) throw imageLimitError();
    throw sanitizationFailedError();
  }

  if (output.data.length > MAX_CHAT_ATTACHMENT_BYTES) {
    throw imageLimitError();
  }

  let sanitizedMetadata;
  try {
    sanitizedMetadata = await sharp(output.data, INPUT_OPTIONS).metadata();
  } catch {
    throw sanitizationFailedError();
  }

  const sanitizedFormat = resolveSourceFormat(sanitizedMetadata);
  const sanitizedGeometry = getImageGeometry(sanitizedMetadata);
  if (
    sanitizedFormat !== format ||
    hasSensitiveMetadata(sanitizedMetadata) ||
    (geometry.animated && sanitizedGeometry.pages !== geometry.pages)
  ) {
    throw sanitizationFailedError();
  }

  return {
    buffer: output.data,
    contentType: CONTENT_TYPES[format],
    width: sanitizedGeometry.width,
    height: sanitizedGeometry.height,
    pages: sanitizedGeometry.pages,
    animated: sanitizedGeometry.animated,
    sourceFormat: format,
  };
}
