import sharp from 'sharp';
import { VMD_IMAGE_VARIANTS, isVmdImageVariant } from './capability.js';

const MAX_INPUT_PIXELS = 25_000_000;
const SUPPORTED_SOURCE_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);

export class VmdMediaError extends Error {
  constructor(message, { code, status }) {
    super(message);
    this.name = 'VmdMediaError';
    this.code = code;
    this.status = status;
  }
}

function unsupportedImageError() {
  return new VmdMediaError('Attachment is not a supported VMD image', {
    code: 'VMD_IMAGE_UNSUPPORTED',
    status: 415,
  });
}

export async function transformVmdImage(source, variant) {
  if (!Buffer.isBuffer(source) || source.length === 0) {
    throw unsupportedImageError();
  }
  if (!isVmdImageVariant(variant)) {
    throw new VmdMediaError('Unsupported VMD image variant', {
      code: 'VMD_VARIANT_UNSUPPORTED',
      status: 400,
    });
  }

  const inputOptions = {
    failOn: 'warning',
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
  };

  let metadata;
  try {
    metadata = await sharp(source, inputOptions).metadata();
  } catch {
    throw unsupportedImageError();
  }

  if (
    !metadata.format ||
    !SUPPORTED_SOURCE_FORMATS.has(metadata.format) ||
    !metadata.width ||
    !metadata.height ||
    (metadata.pages || 1) > 1
  ) {
    throw unsupportedImageError();
  }

  const { bound, quality } = VMD_IMAGE_VARIANTS[variant];
  try {
    const { data, info } = await sharp(source, inputOptions)
      .rotate()
      .resize({
        width: bound,
        height: bound,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality,
        effort: 4,
        smartSubsample: true,
      })
      .toBuffer({ resolveWithObject: true });

    return {
      body: data,
      contentType: 'image/webp',
      width: info.width,
      height: info.height,
    };
  } catch {
    throw unsupportedImageError();
  }
}
