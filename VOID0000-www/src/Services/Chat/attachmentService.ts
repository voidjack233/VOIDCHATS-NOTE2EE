import { encode } from 'blurhash';
import { fetchWithAuth } from '../Auth/authServiceApi';
import { API_URL } from '../config';
import type { Attachment } from './chatTypes';
import {
  AttachmentPreparationError,
  getStaticImageNormalizationPlan,
  isImageLikeAttachment,
  isUnconvertedHeicHeif,
  MAX_ATTACHMENT_FILE_BYTES,
  resolveSupportedAttachmentImageMime,
  type SupportedAttachmentImageMime,
} from './attachmentUploadPolicy';
import {
  getAttachmentRenderIdentity,
  resolveAttachmentRenderSources,
  resolveAttachmentViewerSources,
  type AttachmentRenderSource,
} from './attachmentRenderPolicy';

const BLURHASH_MAX_DIMENSION = 32;
const SIGNED_URL_EXPIRY_SAFETY_MS = 5_000;
const NORMALIZED_IMAGE_QUALITY_STEPS = [0.88, 0.8, 0.72] as const;
const HEIC_HEIF_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1',
]);

interface AttachmentResolveOptions {
  conversationId?: string | null;
}

interface PreparedAttachment {
  file: File;
  attachment: Omit<Attachment, 'url'>;
}

function getPreviewDimensions(width: number, height: number) {
  if (width >= height) {
    return {
      width: BLURHASH_MAX_DIMENSION,
      height: Math.max(1, Math.round((height / width) * BLURHASH_MAX_DIMENSION)),
    };
  }
  return {
    width: Math.max(1, Math.round((width / height) * BLURHASH_MAX_DIMENSION)),
    height: BLURHASH_MAX_DIMENSION,
  };
}

async function loadAttachmentImage(file: File): Promise<{
  image: HTMLImageElement;
  release: () => void;
}> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('IMAGE_LOAD_FAILED'));
      element.src = objectUrl;
    });
    return {
      image,
      release: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function getImageBlurhash(image: HTMLImageElement): string | undefined {
  const dimensions = getPreviewDimensions(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;
  context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
  const pixels = context.getImageData(0, 0, dimensions.width, dimensions.height);
  return encode(pixels.data, dimensions.width, dimensions.height, 4, 4);
}

function getNormalizedOutputMime(mime: SupportedAttachmentImageMime): 'image/jpeg' | 'image/webp' {
  return mime === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
}

function getImageExtension(mime: SupportedAttachmentImageMime): string {
  if (mime === 'image/jpeg') return 'jpg';
  return mime.slice('image/'.length);
}

function getConsistentImageFilename(filename: string, mime: SupportedAttachmentImageMime): string {
  const expectedExtensions = mime === 'image/jpeg' ? ['jpg', 'jpeg'] : [getImageExtension(mime)];
  const trimmed = filename.trim();
  const extension = trimmed.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (extension && expectedExtensions.includes(extension)) return trimmed;
  const basename = trimmed.replace(/\.[^.]+$/, '') || 'attachment';
  return `${basename}.${getImageExtension(mime)}`;
}

function encodeCanvas(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

async function normalizeStaticImage(
  file: File,
  image: HTMLImageElement,
  inputMime: SupportedAttachmentImageMime,
  width: number,
  height: number,
): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new AttachmentPreparationError(
      'Selected image could not be processed safely',
      'ATTACHMENT_IMAGE_SANITIZATION_FAILED',
      422,
    );
  }

  context.drawImage(image, 0, 0, width, height);
  const requestedMime = getNormalizedOutputMime(inputMime);
  let encoded: Blob | null = null;
  try {
    for (const quality of NORMALIZED_IMAGE_QUALITY_STEPS) {
      encoded = await encodeCanvas(canvas, requestedMime, quality);
      if (!encoded || encoded.size === 0) continue;
      if (encoded.size <= MAX_ATTACHMENT_FILE_BYTES) break;
    }
  } catch {
    throw new AttachmentPreparationError(
      'Selected image could not be processed safely',
      'ATTACHMENT_IMAGE_SANITIZATION_FAILED',
      422,
    );
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }

  if (!encoded || encoded.size === 0) {
    throw new AttachmentPreparationError(
      'Selected image format could not be normalized safely',
      'ATTACHMENT_IMAGE_UNSUPPORTED',
      415,
    );
  }
  if (encoded.size > MAX_ATTACHMENT_FILE_BYTES) {
    throw new AttachmentPreparationError(
      'Attachment exceeds the 10 MiB limit after image processing',
      'ATTACHMENT_TOO_LARGE',
      413,
    );
  }

  const outputMime = resolveSupportedAttachmentImageMime({
    name: file.name,
    type: encoded.type,
  });
  if (!outputMime || outputMime === 'image/gif') {
    throw new AttachmentPreparationError(
      'Selected image format could not be normalized safely',
      'ATTACHMENT_IMAGE_UNSUPPORTED',
      415,
    );
  }

  return new File(
    [encoded],
    getConsistentImageFilename(file.name, outputMime),
    { type: outputMime, lastModified: file.lastModified },
  );
}

function readAscii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

async function hasHeicHeifSignature(file: File): Promise<boolean> {
  if (file.size < 12) return false;
  const prefix = new Uint8Array(await file.slice(0, Math.min(file.size, 128)).arrayBuffer());
  if (readAscii(prefix.subarray(4, 8)) !== 'ftyp') return false;
  for (let offset = 8; offset + 4 <= prefix.length; offset += 4) {
    if (HEIC_HEIF_BRANDS.has(readAscii(prefix.subarray(offset, offset + 4)))) return true;
  }
  return false;
}

async function isAnimatedWebP(file: File): Promise<boolean> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (
    header.length !== 12 ||
    readAscii(header.subarray(0, 4)) !== 'RIFF' ||
    readAscii(header.subarray(8, 12)) !== 'WEBP'
  ) {
    throw new AttachmentPreparationError(
      'Selected image is invalid or corrupted',
      'ATTACHMENT_IMAGE_INVALID',
      400,
    );
  }

  let offset = 12;
  let chunks = 0;
  while (offset + 8 <= file.size && chunks < 256) {
    const chunkHeader = new Uint8Array(await file.slice(offset, offset + 8).arrayBuffer());
    if (chunkHeader.length !== 8) break;
    const chunkType = readAscii(chunkHeader.subarray(0, 4));
    const chunkSize = new DataView(
      chunkHeader.buffer,
      chunkHeader.byteOffset + 4,
      4,
    ).getUint32(0, true);
    const nextOffset = offset + 8 + chunkSize + (chunkSize % 2);
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > file.size) {
      throw new AttachmentPreparationError(
        'Selected image is invalid or corrupted',
        'ATTACHMENT_IMAGE_INVALID',
        400,
      );
    }
    if (chunkType === 'ANIM' || chunkType === 'ANMF') return true;
    if (chunkType === 'VP8X' && chunkSize > 0) {
      const flags = new Uint8Array(await file.slice(offset + 8, offset + 9).arrayBuffer());
      if (flags[0] !== undefined && (flags[0] & 0x02) !== 0) return true;
    }
    offset = nextOffset;
    chunks += 1;
  }

  if (offset !== file.size || chunks >= 256) {
    throw new AttachmentPreparationError(
      'Selected image is invalid or corrupted',
      'ATTACHMENT_IMAGE_INVALID',
      400,
    );
  }
  return false;
}

export async function prepareAttachmentFile(file: File): Promise<PreparedAttachment> {
  if (file.size > MAX_ATTACHMENT_FILE_BYTES) {
    throw new AttachmentPreparationError(
      'Attachment exceeds the 10 MiB limit',
      'ATTACHMENT_TOO_LARGE',
      413,
    );
  }
  if (isUnconvertedHeicHeif(file) || await hasHeicHeifSignature(file)) {
    throw new AttachmentPreparationError(
      'HEIC/HEIF images are not supported here. Choose the photo through Media or convert it to JPEG/PNG.',
      'ATTACHMENT_HEIC_UNSUPPORTED',
      415,
    );
  }

  const imageMime = resolveSupportedAttachmentImageMime(file);
  if (!imageMime) {
    if (isImageLikeAttachment(file)) {
      throw new AttachmentPreparationError(
        'Selected image format is not supported',
        'ATTACHMENT_IMAGE_UNSUPPORTED',
        415,
      );
    }
    return {
      file,
      attachment: {
        mime: file.type || 'application/octet-stream',
        name: file.name || undefined,
        size: file.size,
      },
    };
  }

  let loadedImage;
  try {
    loadedImage = await loadAttachmentImage(file);
  } catch {
    throw new AttachmentPreparationError(
      'Selected image is invalid or corrupted',
      'ATTACHMENT_IMAGE_INVALID',
      400,
    );
  }

  try {
    const plan = getStaticImageNormalizationPlan(
      loadedImage.image.naturalWidth,
      loadedImage.image.naturalHeight,
    );
    let uploadFile = file;
    if (plan.required) {
      const animated = imageMime === 'image/gif' ||
        (imageMime === 'image/webp' && await isAnimatedWebP(file));
      if (animated) {
        throw new AttachmentPreparationError(
          'Animated image resolution exceeds safe processing limits',
          'ATTACHMENT_IMAGE_LIMIT_EXCEEDED',
          413,
        );
      }
      uploadFile = await normalizeStaticImage(
        file,
        loadedImage.image,
        imageMime,
        plan.width,
        plan.height,
      );
    }

    const uploadMime = resolveSupportedAttachmentImageMime(uploadFile) || imageMime;
    return {
      file: uploadFile,
      attachment: {
        mime: uploadMime,
        name: getConsistentImageFilename(uploadFile.name || file.name, uploadMime),
        size: uploadFile.size,
        width: plan.width,
        height: plan.height,
        blurhash: getImageBlurhash(loadedImage.image),
      },
    };
  } finally {
    loadedImage.release();
  }
}

function shouldUseAuthenticatedFetch(url: string): boolean {
  if (url.startsWith('/api/')) return true;
  try {
    const parsed = new URL(url, window.location.origin);
    const apiBase = API_URL ? new URL(API_URL, window.location.origin) : null;
    return (
      (parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/')) ||
      Boolean(apiBase && parsed.origin === apiBase.origin && parsed.pathname.startsWith('/api/'))
    );
  } catch {
    return false;
  }
}

function getAttachmentFallbackUrl(attachment: Attachment): string | null {
  const fallbackUrl = attachment.fallback_url?.trim();
  return fallbackUrl || null;
}

function isDirectAttachmentDeliveryUrl(url: string): boolean {
  if (shouldUseAuthenticatedFetch(url)) return false;
  try {
    return ['http:', 'https:'].includes(new URL(url, window.location.origin).protocol);
  } catch {
    return false;
  }
}

export function isAttachmentDeliveryUrlUsable(
  url: string,
  expiresAt?: number,
): boolean {
  if (!isDirectAttachmentDeliveryUrl(url)) return false;
  if (expiresAt === undefined) return true;
  return Number.isFinite(expiresAt) &&
    expiresAt > Date.now() + SIGNED_URL_EXPIRY_SAFETY_MS;
}

function isPrimaryAttachmentUrlUsable(attachment: Attachment): boolean {
  return isAttachmentDeliveryUrlUsable(attachment.url, attachment.url_expires_at);
}

async function fetchAttachmentResource(url: string, isExpiringCapability: boolean): Promise<Response> {
  const options: RequestInit = {
    cache: isExpiringCapability ? 'no-store' : 'force-cache',
  };
  return shouldUseAuthenticatedFetch(url)
    ? fetchWithAuth(url, options)
    : fetch(url, options);
}

export async function resolveAttachmentBlob(
  attachment: Attachment,
  _options?: AttachmentResolveOptions,
): Promise<Blob> {
  void _options;
  const fallbackUrl = getAttachmentFallbackUrl(attachment);
  const primaryUrl = isPrimaryAttachmentUrlUsable(attachment)
    ? attachment.url
    : (fallbackUrl || attachment.url);

  try {
    const response = await fetchAttachmentResource(
      primaryUrl,
      primaryUrl === attachment.url && typeof attachment.url_expires_at === 'number',
    );
    if (response.ok) {
      return response.blob();
    }
    if (!fallbackUrl || primaryUrl === fallbackUrl) {
      throw new Error(`Attachment download failed with status ${response.status}`);
    }
  } catch (error) {
    if (!fallbackUrl || primaryUrl === fallbackUrl) {
      throw error;
    }
  }

  const fallbackResponse = await fetchAttachmentResource(fallbackUrl, false);
  if (!fallbackResponse.ok) {
    throw new Error(`Attachment fallback download failed with status ${fallbackResponse.status}`);
  }
  return fallbackResponse.blob();
}

export function getCachedAttachmentObjectUrl(attachment: Attachment): string | null {
  return getAttachmentRenderUrls(attachment)[0] || null;
}

export function getAttachmentRenderSources(
  attachment: Attachment,
): AttachmentRenderSource[] {
  return resolveAttachmentRenderSources(attachment, {
    isUrlUsable: isAttachmentDeliveryUrlUsable,
  });
}

export function getAttachmentRenderUrls(attachment: Attachment): string[] {
  return getAttachmentRenderSources(attachment).map(({ url }) => url);
}

export function getAttachmentViewerSources(
  attachment: Attachment,
): AttachmentRenderSource[] {
  return resolveAttachmentViewerSources(attachment, {
    isUrlUsable: isAttachmentDeliveryUrlUsable,
  });
}

export function getAttachmentViewerUrl(attachment: Attachment): string | null {
  return getAttachmentViewerSources(attachment)[0]?.url || null;
}

export { getAttachmentRenderIdentity };
export type { AttachmentRenderSource };
