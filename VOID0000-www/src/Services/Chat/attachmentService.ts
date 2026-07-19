import { encode } from 'blurhash';
import { fetchWithAuth } from '../Auth/authServiceApi';
import { API_URL } from '../config';
import type { Attachment } from './chatTypes';

const BASE64_CHUNK_SIZE = 0x8000;
const BLURHASH_MAX_DIMENSION = 32;
const MAX_CACHED_ATTACHMENT_OBJECT_URLS = 128;
const SIGNED_URL_EXPIRY_SAFETY_MS = 5_000;
const attachmentObjectUrlCache = new Map<string, string>();
const attachmentObjectUrlRequests = new Map<string, Promise<string>>();
let attachmentCacheGeneration = 0;

interface AttachmentResolveOptions {
  conversationId?: string | null;
}

interface PreparedAttachment {
  data: string;
  attachment: Omit<Attachment, 'url'>;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
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

async function getImagePreview(file: File) {
  if (!file.type.startsWith('image/')) return {};
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('IMAGE_LOAD_FAILED'));
      element.src = objectUrl;
    });
    const dimensions = getPreviewDimensions(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let blurhash: string | undefined;
    if (context) {
      context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
      const pixels = context.getImageData(0, 0, dimensions.width, dimensions.height);
      blurhash = encode(pixels.data, dimensions.width, dimensions.height, 4, 4);
    }
    return {
      width: image.naturalWidth || undefined,
      height: image.naturalHeight || undefined,
      blurhash,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function prepareAttachmentFile(file: File): Promise<PreparedAttachment> {
  const preview = await getImagePreview(file).catch(() => ({}));
  return {
    data: arrayBufferToBase64(await file.arrayBuffer()),
    attachment: {
      mime: file.type || 'application/octet-stream',
      name: file.name || undefined,
      size: file.size,
      ...preview,
    },
  };
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

function isPrimaryAttachmentUrlUsable(attachment: Attachment): boolean {
  if (
    typeof attachment.url_expires_at !== 'number' ||
    !Number.isFinite(attachment.url_expires_at)
  ) {
    return true;
  }
  return Number(attachment.url_expires_at) > Date.now() + SIGNED_URL_EXPIRY_SAFETY_MS;
}

function getAttachmentCacheKey(attachment: Attachment): string {
  return getAttachmentFallbackUrl(attachment) || attachment.url;
}

function requiresAttachmentBlobResolution(attachment: Attachment): boolean {
  return shouldUseAuthenticatedFetch(attachment.url) || Boolean(getAttachmentFallbackUrl(attachment));
}

async function fetchAttachmentResource(url: string, isExpiringCapability: boolean): Promise<Response> {
  const options: RequestInit = {
    cache: isExpiringCapability ? 'no-store' : 'force-cache',
  };
  return shouldUseAuthenticatedFetch(url)
    ? fetchWithAuth(url, options)
    : fetch(url, options);
}

function withAttachmentMime(blob: Blob, mime?: string): Blob {
  const normalizedMime = mime?.trim().toLowerCase();
  if (!normalizedMime || blob.type === normalizedMime) {
    return blob;
  }

  return new Blob([blob], { type: normalizedMime });
}

function cacheAttachmentObjectUrl(key: string, objectUrl: string): void {
  const existingUrl = attachmentObjectUrlCache.get(key);
  if (existingUrl && existingUrl !== objectUrl) {
    URL.revokeObjectURL(existingUrl);
  }
  attachmentObjectUrlCache.delete(key);

  while (attachmentObjectUrlCache.size >= MAX_CACHED_ATTACHMENT_OBJECT_URLS) {
    const oldestEntry = attachmentObjectUrlCache.entries().next().value as
      | [string, string]
      | undefined;
    if (!oldestEntry) break;
    attachmentObjectUrlCache.delete(oldestEntry[0]);
    URL.revokeObjectURL(oldestEntry[1]);
  }

  attachmentObjectUrlCache.set(key, objectUrl);
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

export async function resolveAttachmentObjectUrl(
  attachment: Attachment,
  options?: AttachmentResolveOptions,
): Promise<string> {
  if (!requiresAttachmentBlobResolution(attachment)) {
    return attachment.url;
  }

  const cachedUrl = getCachedAttachmentObjectUrl(attachment);
  if (cachedUrl) {
    return cachedUrl;
  }

  const cacheKey = getAttachmentCacheKey(attachment);
  const existingRequest = attachmentObjectUrlRequests.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  const requestGeneration = attachmentCacheGeneration;
  const request = resolveAttachmentBlob(attachment, options).then((blob) => {
    const objectUrl = URL.createObjectURL(withAttachmentMime(blob, attachment.mime));
    if (requestGeneration !== attachmentCacheGeneration) {
      URL.revokeObjectURL(objectUrl);
      throw new Error('Attachment cache was cleared while loading');
    }

    cacheAttachmentObjectUrl(cacheKey, objectUrl);
    return objectUrl;
  });

  attachmentObjectUrlRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (attachmentObjectUrlRequests.get(cacheKey) === request) {
      attachmentObjectUrlRequests.delete(cacheKey);
    }
  }
}

export function getCachedAttachmentObjectUrl(attachment: Attachment): string | null {
  if (!requiresAttachmentBlobResolution(attachment)) {
    return attachment.url;
  }

  const cacheKey = getAttachmentCacheKey(attachment);
  const cachedUrl = attachmentObjectUrlCache.get(cacheKey);
  if (!cachedUrl) {
    return null;
  }

  attachmentObjectUrlCache.delete(cacheKey);
  attachmentObjectUrlCache.set(cacheKey, cachedUrl);
  return cachedUrl;
}

export function clearAttachmentCaches(): void {
  attachmentCacheGeneration += 1;
  attachmentObjectUrlRequests.clear();
  attachmentObjectUrlCache.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
  attachmentObjectUrlCache.clear();
}
