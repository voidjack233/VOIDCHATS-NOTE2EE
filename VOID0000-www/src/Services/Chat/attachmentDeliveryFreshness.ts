import type { Attachment } from './chatTypes';
import { parseAttachment } from './messageAttachments';

const DELIVERY_EXPIRY_SAFETY_MS = 5_000;
const UUID_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PROTECTED_ATTACHMENT_PATH =
  new RegExp(`^/api/conversations/[^/]+/attachments/${UUID_SOURCE}/?$`, 'i');
const IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
]);
const IMAGE_FILENAME_PATTERN = /\.(avif|gif|jpe?g|png|tiff?|webp)$/i;

function isImageDescriptor(attachment: Attachment): boolean {
  const mime = attachment.mime?.split(';', 1)[0]?.trim().toLowerCase() || '';
  if (mime) return IMAGE_MIME_TYPES.has(mime);

  if (
    Number.isFinite(attachment.width) &&
    Number(attachment.width) > 0 &&
    Number.isFinite(attachment.height) &&
    Number(attachment.height) > 0
  ) {
    return true;
  }
  return Boolean(attachment.name && IMAGE_FILENAME_PATTERN.test(attachment.name.trim()));
}

function isFreshDirectUrl(
  url: string | undefined,
  expiresAt: number | undefined,
  now: number,
): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url, 'https://attachment.invalid');
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.origin === 'https://attachment.invalid') return false;
  } catch {
    return false;
  }

  return expiresAt === undefined ||
    (Number.isFinite(expiresAt) && expiresAt > now + DELIVERY_EXPIRY_SAFETY_MS);
}

function hasProtectedStableUrl(attachment: Attachment): boolean {
  const stableUrl = attachment.fallback_url?.trim() || attachment.url?.trim() || '';
  try {
    const parsed = new URL(stableUrl, 'https://attachment.invalid');
    return PROTECTED_ATTACHMENT_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

function hasFreshDisplayDelivery(attachment: Attachment, now: number): boolean {
  if (
    isFreshDirectUrl(
      attachment.display_url,
      attachment.display_url_expires_at,
      now,
    )
  ) {
    return true;
  }

  return (['small', 'medium'] as const).some((variantName) => {
    const variant = attachment.display_variants?.[variantName];
    return Boolean(variant) &&
      isFreshDirectUrl(variant?.url, variant?.expires_at, now);
  });
}

export function attachmentNeedsDeliveryRefresh(
  attachment: Attachment,
  now = Date.now(),
): boolean {
  if (!isImageDescriptor(attachment) || !hasProtectedStableUrl(attachment)) {
    return false;
  }
  // An explicit server denial is stable and must not become a refresh loop.
  if (attachment.inline === false) return false;
  if (hasFreshDisplayDelivery(attachment, now)) return false;
  if (
    attachment.inline === true &&
    isFreshDirectUrl(attachment.url, attachment.url_expires_at, now)
  ) {
    return false;
  }
  return true;
}

export function messagesNeedAttachmentDeliveryRefresh(
  messages: Array<{ attachments?: string[] }>,
  now = Date.now(),
): boolean {
  return messages.some((message) => (
    (message.attachments || []).some((rawAttachment) => (
      attachmentNeedsDeliveryRefresh(parseAttachment(rawAttachment), now)
    ))
  ));
}
