import sharp from 'sharp';
import { VMD_IMAGE_VARIANTS, isVmdImageVariant } from './capability.js';

type SharpInstance = ReturnType<typeof sharp>;
type SharpMetadata = Awaited<ReturnType<SharpInstance['metadata']>>;
type SharpInputOptions = NonNullable<Parameters<typeof sharp>[1]>;

export type VmdTransformedImage = {
  body: Buffer;
  contentType: 'image/webp';
  width: number;
  height: number;
  pages: number;
};

const MAX_STATIC_PIXELS = 25_000_000;
const MAX_ANIMATED_FRAME_PIXELS = 12_000_000;
const MAX_ANIMATED_TOTAL_PIXELS = 30_000_000;
const MAX_ANIMATION_FRAMES = 60;
const SUPPORTED_SOURCE_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff']);
const ANIMATED_SOURCE_FORMATS = new Set(['gif', 'webp']);

export class VmdMediaError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, { code, status }: { code: string; status: number }) {
    super(message);
    this.name = 'VmdMediaError';
    this.code = code;
    this.status = status;
  }
}

function unsupportedImageError(): VmdMediaError {
  return new VmdMediaError('Attachment is not a supported VMD image', {
    code: 'VMD_IMAGE_UNSUPPORTED',
    status: 415,
  });
}

function imageLimitError(): VmdMediaError {
  return new VmdMediaError('Attachment exceeds VMD image safety limits', {
    code: 'VMD_IMAGE_LIMIT_EXCEEDED',
    status: 413,
  });
}

function isPixelLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /pixel limit|too many pixels|exceeds.*pixels/i.test(message);
}

function isLikelySvg(source: Buffer): boolean {
  if (source[0] === 0x1f && source[1] === 0x8b) return true;

  let offset = source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf ? 3 : 0;
  if (
    (source[offset] === 0xff && source[offset + 1] === 0xfe) ||
    (source[offset] === 0xfe && source[offset + 1] === 0xff)
  ) {
    return true;
  }

  while (offset < source.length) {
    const byte = source[offset];
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) break;
    offset += 1;
  }
  return source[offset] === 0x3c;
}

function isSupportedSource(metadata: SharpMetadata): boolean {
  if (SUPPORTED_SOURCE_FORMATS.has(metadata.format)) return true;
  return metadata.format === 'heif' && metadata.compression === 'av1';
}

export async function transformVmdImage(
  source: unknown,
  variant: unknown,
): Promise<VmdTransformedImage> {
  if (!Buffer.isBuffer(source) || source.length === 0) {
    throw unsupportedImageError();
  }
  if (isLikelySvg(source)) {
    throw unsupportedImageError();
  }
  if (!isVmdImageVariant(variant)) {
    throw new VmdMediaError('Unsupported VMD image variant', {
      code: 'VMD_VARIANT_UNSUPPORTED',
      status: 400,
    });
  }

  const inputOptions: SharpInputOptions = {
    failOn: 'warning',
    limitInputPixels: MAX_ANIMATED_TOTAL_PIXELS,
    sequentialRead: true,
    animated: true,
  };

  let metadata;
  try {
    metadata = await sharp(source, inputOptions).metadata();
  } catch (error) {
    if (isPixelLimitError(error)) throw imageLimitError();
    throw unsupportedImageError();
  }

  const pages = metadata.pages || 1;
  const frameHeight = metadata.pageHeight || metadata.height;
  const framePixels = Number(metadata.width) * Number(frameHeight);
  const totalPixels = framePixels * pages;
  const animated = pages > 1;

  if (
    !metadata.format ||
    !isSupportedSource(metadata) ||
    !metadata.width ||
    !frameHeight
  ) {
    throw unsupportedImageError();
  }
  if (animated && !ANIMATED_SOURCE_FORMATS.has(metadata.format)) {
    throw unsupportedImageError();
  }
  if (
    (!animated && framePixels > MAX_STATIC_PIXELS) ||
    (animated && (
      pages > MAX_ANIMATION_FRAMES ||
      framePixels > MAX_ANIMATED_FRAME_PIXELS ||
      totalPixels > MAX_ANIMATED_TOTAL_PIXELS
    ))
  ) {
    throw imageLimitError();
  }

  const { bound, quality } = VMD_IMAGE_VARIANTS[variant];
  try {
    const outputOptions = {
      quality,
      effort: animated ? 3 : 4,
      smartSubsample: true,
      ...(animated ? {
        loop: metadata.loop ?? 0,
        delay: metadata.delay,
      } : {}),
    };
    const { data, info } = await sharp(source, {
      ...inputOptions,
      animated,
    })
      .rotate()
      .resize({
        width: bound,
        height: bound,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp(outputOptions)
      .toBuffer({ resolveWithObject: true });

    return {
      body: data,
      contentType: 'image/webp',
      width: info.width,
      height: info.pageHeight || info.height,
      pages: info.pages || 1,
    };
  } catch (error) {
    if (error instanceof VmdMediaError) throw error;
    if (isPixelLimitError(error)) throw imageLimitError();
    throw unsupportedImageError();
  }
}
