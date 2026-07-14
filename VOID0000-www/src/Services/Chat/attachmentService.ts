import { encode } from 'blurhash';
import { fetchWithAuth } from '../Auth/authServiceApi';
import { API_URL } from '../config';
import type { Attachment } from './chatTypes';

const BASE64_CHUNK_SIZE = 0x8000;
const BLURHASH_MAX_DIMENSION = 32;

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

export async function resolveAttachmentBlob(
  attachment: Attachment,
  _options?: AttachmentResolveOptions,
): Promise<Blob> {
  void _options;
  const response = shouldUseAuthenticatedFetch(attachment.url)
    ? await fetchWithAuth(attachment.url, { cache: 'force-cache' })
    : await fetch(attachment.url, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Attachment download failed with status ${response.status}`);
  }
  return response.blob();
}

export async function resolveAttachmentObjectUrl(
  attachment: Attachment,
  _options?: AttachmentResolveOptions,
): Promise<string> {
  void _options;
  return attachment.url;
}

export function getCachedAttachmentObjectUrl(attachment: Attachment): string | null {
  return attachment.url;
}

export function clearAttachmentCaches(): void {}
