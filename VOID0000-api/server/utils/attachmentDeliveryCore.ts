const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PROTECTED_ATTACHMENT_PATH_PATTERN = new RegExp(
  `^/api/conversations/[^/]+/attachments/(${UUID_SOURCE})/?$`,
  'i',
);
const TRANSIENT_ATTACHMENT_FIELDS = new Set([
  'fallback_url',
  'url_expires_at',
  'display_url',
  'display_url_expires_at',
  'display_variants',
  'inline',
]);
const VMD_IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
]);
const VMD_IMAGE_FILENAME_PATTERN = /\.(avif|gif|jpe?g|png|tiff?|webp)$/i;
export const DEFAULT_ATTACHMENT_DELIVERY_MAX_CONCURRENCY = 8;
export const MAX_ATTACHMENT_DELIVERY_MAX_CONCURRENCY = 32;

export interface AttachmentDescriptor extends Record<string, unknown> {
  url: string;
}

export interface AttachmentMessage extends Record<string, unknown> {
  attachments: string[];
}

export interface AttachmentObject extends Record<string, unknown> {
  id: string | number;
  object_key: string;
}

export interface OriginalAttachmentDelivery extends Record<string, unknown> {
  url: string;
  url_expires_at?: unknown;
  inline?: unknown;
}

export interface ImageAttachmentDelivery extends Record<string, unknown> {
  display_url: string;
  display_url_expires_at?: unknown;
  display_variants?: unknown;
}

interface AttachmentDeliveryLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

interface AttachmentDeliveryMapperOptions {
  queryAttachmentObjects(
    conversationId: string,
    attachmentIds: string[],
  ): Promise<AttachmentObject[]>;
  createOriginalDelivery(
    objectKey: string,
    attachmentObject: AttachmentObject,
  ): Promise<OriginalAttachmentDelivery>;
  createImageDelivery?: (
    attachmentId: string,
  ) => ImageAttachmentDelivery | Promise<ImageAttachmentDelivery>;
  logger?: AttachmentDeliveryLogger;
  maxConcurrency?: unknown;
}

interface ParsedAttachmentEntry {
  descriptor: AttachmentDescriptor | null;
  stableUrl: string;
  attachmentId: string | null;
}

interface AttachmentDeliveryPair {
  originalDelivery: OriginalAttachmentDelivery;
  imageDelivery: ImageAttachmentDelivery | null;
}

export function resolveAttachmentDeliveryMaxConcurrency(value: unknown): number {
  let configured: unknown = value;
  if (typeof configured === 'string') {
    const normalized = configured.trim();
    if (!/^\d+$/.test(normalized)) {
      return DEFAULT_ATTACHMENT_DELIVERY_MAX_CONCURRENCY;
    }
    configured = Number(normalized);
  }

  if (
    typeof configured !== 'number' ||
    !Number.isSafeInteger(configured) ||
    configured <= 0 ||
    configured > MAX_ATTACHMENT_DELIVERY_MAX_CONCURRENCY
  ) {
    return DEFAULT_ATTACHMENT_DELIVERY_MAX_CONCURRENCY;
  }

  return configured;
}

async function mapWithBoundedConcurrency<Item, Result>(
  items: readonly Item[],
  maxConcurrency: number,
  mapper: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (items.length === 0) return [];

  const results = new Array<Result>(items.length);
  const workerCount = Math.min(maxConcurrency, items.length);
  let nextIndex = 0;
  let firstError: unknown;
  let hasError = false;

  const workers = Array.from({ length: workerCount }, async () => {
    while (!hasError) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;

      try {
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      } catch (error) {
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
      }
    }
  });

  await Promise.all(workers);
  if (hasError) throw firstError;
  return results;
}

function parseAttachmentDescriptor(rawAttachment: unknown): AttachmentDescriptor | null {
  if (typeof rawAttachment !== 'string' || rawAttachment.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawAttachment);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'url' in parsed &&
      typeof parsed.url === 'string'
    ) {
      return { ...parsed, url: parsed.url };
    }
  } catch {
    // Existing rows may contain a URL without serialized display metadata.
  }

  return { url: rawAttachment };
}

function getStableAttachmentUrl(descriptor: AttachmentDescriptor): string {
  if (typeof descriptor.fallback_url === 'string' && descriptor.fallback_url.trim()) {
    return descriptor.fallback_url.trim();
  }
  return typeof descriptor.url === 'string' ? descriptor.url.trim() : '';
}

function getProtectedAttachmentId(url: string): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url, 'https://attachment.invalid');
    const match = parsed.pathname.match(PROTECTED_ATTACHMENT_PATH_PATTERN);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function serializeStableAttachment(
  descriptor: AttachmentDescriptor,
  stableUrl: string,
): string {
  const stableDescriptor = Object.fromEntries(
    Object.entries(descriptor).filter(([key, value]) => (
      !TRANSIENT_ATTACHMENT_FIELDS.has(key) && value !== undefined
    )),
  );
  stableDescriptor.url = stableUrl;

  if (Object.keys(stableDescriptor).length === 1) {
    return stableUrl;
  }
  return JSON.stringify(stableDescriptor);
}

export function isVmdEligibleImageAttachment(
  descriptor: AttachmentDescriptor | null | undefined,
): boolean {
  const mime = typeof descriptor?.mime === 'string'
    ? descriptor.mime.split(';', 1)[0].trim().toLowerCase()
    : '';
  if (mime) {
    return VMD_IMAGE_MIME_TYPES.has(mime);
  }

  const width = descriptor?.width;
  const height = descriptor?.height;
  const hasImageDimensions = typeof width === 'number' && Number.isFinite(width) && width > 0 &&
    typeof height === 'number' && Number.isFinite(height) && height > 0;
  if (hasImageDimensions) return true;

  return typeof descriptor?.name === 'string' &&
    VMD_IMAGE_FILENAME_PATTERN.test(descriptor.name.trim());
}

export function normalizeStoredAttachments(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];

  return attachments.flatMap((rawAttachment) => {
    const descriptor = parseAttachmentDescriptor(rawAttachment);
    if (!descriptor) return [];
    const stableUrl = getStableAttachmentUrl(descriptor);
    return stableUrl ? [serializeStableAttachment(descriptor, stableUrl)] : [];
  });
}

export function createAttachmentDeliveryMapper({
  queryAttachmentObjects,
  createOriginalDelivery,
  createImageDelivery,
  logger = console,
  maxConcurrency = DEFAULT_ATTACHMENT_DELIVERY_MAX_CONCURRENCY,
}: AttachmentDeliveryMapperOptions) {
  if (typeof queryAttachmentObjects !== 'function') {
    throw new TypeError('queryAttachmentObjects is required');
  }
  if (typeof createOriginalDelivery !== 'function') {
    throw new TypeError('createOriginalDelivery is required');
  }
  const deliveryMaxConcurrency =
    resolveAttachmentDeliveryMaxConcurrency(maxConcurrency);

  return async function attachSignedAttachmentUrls(
    messages: AttachmentMessage[],
    conversationId: string,
  ): Promise<AttachmentMessage[]> {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    const parsedByMessage: ParsedAttachmentEntry[][] = messages.map((message) => (
      (message.attachments || []).map((rawAttachment) => {
        const descriptor = parseAttachmentDescriptor(rawAttachment);
        const stableUrl = descriptor ? getStableAttachmentUrl(descriptor) : '';
        return {
          descriptor,
          stableUrl,
          attachmentId: getProtectedAttachmentId(stableUrl),
        };
      })
    ));
    const parsedEntries = parsedByMessage.flat();
    const attachmentIds = [...new Set(
      parsedEntries
        .map((entry) => entry.attachmentId)
        .filter((attachmentId): attachmentId is string => Boolean(attachmentId)),
    )];

    if (attachmentIds.length === 0) return messages;

    try {
      const attachmentObjects = await queryAttachmentObjects(conversationId, attachmentIds);
      const attachmentObjectById = new Map(
        attachmentObjects.map((row) => [String(row.id), row]),
      );
      const imageAttachmentIds = new Set(
        parsedEntries
          .filter((entry) => (
            entry.attachmentId && isVmdEligibleImageAttachment(entry.descriptor)
          ))
          .map((entry) => entry.attachmentId),
      );
      const signedEntries = await mapWithBoundedConcurrency<
        [string, AttachmentObject],
        [string, AttachmentDeliveryPair]
      >(
        [...attachmentObjectById.entries()],
        deliveryMaxConcurrency,
        async ([attachmentId, attachmentObject]) => {
          const originalDelivery = await createOriginalDelivery(
            attachmentObject.object_key,
            attachmentObject,
          );
          let imageDelivery: ImageAttachmentDelivery | null = null;

          if (
            imageAttachmentIds.has(attachmentId) &&
            createImageDelivery &&
            originalDelivery.inline === true
          ) {
            try {
              imageDelivery = await createImageDelivery(attachmentId);
            } catch (error) {
              logger.warn('[VMD] capability generation failed; using original delivery', {
                attachment_id: attachmentId,
                error: error instanceof Error ? error.message : String(error || ''),
              });
            }
          }

          return [attachmentId, { originalDelivery, imageDelivery }];
        },
      );
      const deliveryById = new Map(signedEntries);

      return messages.map((message, messageIndex) => ({
        ...message,
        attachments: parsedByMessage[messageIndex].map((entry, attachmentIndex) => {
          if (!entry.descriptor || !entry.stableUrl || !entry.attachmentId) {
            return message.attachments[attachmentIndex];
          }

          const delivery = deliveryById.get(entry.attachmentId);
          if (!delivery) {
            return serializeStableAttachment(entry.descriptor, entry.stableUrl);
          }

          const deliveredDescriptor: AttachmentDescriptor = {
            ...entry.descriptor,
            id: entry.attachmentId,
            url: delivery.originalDelivery.url,
            fallback_url: entry.stableUrl,
            url_expires_at: delivery.originalDelivery.url_expires_at,
            inline: delivery.originalDelivery.inline === true,
          };
          if (
            delivery.imageDelivery &&
            isVmdEligibleImageAttachment(entry.descriptor)
          ) {
            deliveredDescriptor.display_url = delivery.imageDelivery.display_url;
            deliveredDescriptor.display_url_expires_at =
              delivery.imageDelivery.display_url_expires_at;
            if (
              delivery.imageDelivery.display_variants &&
              typeof delivery.imageDelivery.display_variants === 'object'
            ) {
              deliveredDescriptor.display_variants =
                delivery.imageDelivery.display_variants;
            }
          }

          return JSON.stringify(deliveredDescriptor);
        }),
      }));
    } catch (error) {
      logger.warn('[ATTACHMENT_DELIVERY] signed URL generation failed; using protected URLs', {
        conversation_id: conversationId,
        error: error instanceof Error ? error.message : String(error || ''),
      });
      return messages.map((message, messageIndex) => ({
        ...message,
        attachments: parsedByMessage[messageIndex].map((entry, attachmentIndex) => (
          entry.descriptor && entry.stableUrl
            ? serializeStableAttachment(entry.descriptor, entry.stableUrl)
            : message.attachments[attachmentIndex]
        )),
      }));
    }
  };
}
