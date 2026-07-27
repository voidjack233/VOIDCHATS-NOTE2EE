import type { Attachment } from './chatTypes';

export interface AttachmentRenderSource {
  kind: 'display' | 'original';
  url: string;
  srcSet?: string;
  sizes?: string;
}

interface AttachmentRenderPolicyOptions {
  isUrlUsable: (url: string, expiresAt?: number) => boolean;
}

type DisplayVariant = {
  url: string;
  expires_at: number;
  width: number;
};

const TIMELINE_IMAGE_SIZES = '(max-width: 640px) calc(100vw - 5rem), 480px';
const VIEWER_IMAGE_SIZES = '90vw';

function getUsableVariant(
  attachment: Attachment,
  variant: 'thumb' | 'small' | 'medium' | 'large',
  isUrlUsable: AttachmentRenderPolicyOptions['isUrlUsable'],
): DisplayVariant | null {
  const candidate = attachment.display_variants?.[variant];
  if (
    !candidate ||
    typeof candidate.url !== 'string' ||
    !Number.isFinite(candidate.width) ||
    candidate.width <= 0 ||
    !isUrlUsable(candidate.url, candidate.expires_at)
  ) {
    return null;
  }
  return candidate;
}

function buildDisplaySource(
  variants: Array<DisplayVariant | null>,
  sizes: string,
): AttachmentRenderSource | null {
  const usable = variants.filter((variant): variant is DisplayVariant => Boolean(variant));
  if (usable.length === 0) return null;

  const unique = [...new Map(usable.map((variant) => [variant.url, variant])).values()]
    .sort((left, right) => left.width - right.width);
  const primary = unique[0]!;
  return {
    kind: 'display',
    url: primary.url,
    srcSet: unique.map((variant) => `${variant.url} ${variant.width}w`).join(', '),
    sizes,
  };
}

function getLegacyDisplaySource(
  attachment: Attachment,
  isUrlUsable: AttachmentRenderPolicyOptions['isUrlUsable'],
): AttachmentRenderSource | null {
  const displayUrl = attachment.display_url?.trim() || '';
  return displayUrl && isUrlUsable(displayUrl, attachment.display_url_expires_at)
    ? { kind: 'display', url: displayUrl }
    : null;
}

function getOriginalSource(
  attachment: Attachment,
  excludedUrl: string,
  isUrlUsable: AttachmentRenderPolicyOptions['isUrlUsable'],
): AttachmentRenderSource | null {
  return attachment.inline === true &&
    attachment.url !== excludedUrl &&
    isUrlUsable(attachment.url, attachment.url_expires_at)
    ? { kind: 'original', url: attachment.url }
    : null;
}

export function resolveAttachmentRenderSources(
  attachment: Attachment,
  { isUrlUsable }: AttachmentRenderPolicyOptions,
): AttachmentRenderSource[] {
  const sources: AttachmentRenderSource[] = [];
  const displaySource = buildDisplaySource([
    getUsableVariant(attachment, 'small', isUrlUsable),
    getUsableVariant(attachment, 'medium', isUrlUsable),
  ], TIMELINE_IMAGE_SIZES) || getLegacyDisplaySource(attachment, isUrlUsable);
  if (displaySource) sources.push(displaySource);

  const originalSource = getOriginalSource(
    attachment,
    displaySource?.url || '',
    isUrlUsable,
  );
  if (originalSource) sources.push(originalSource);

  return sources;
}

export function resolveAttachmentViewerSources(
  attachment: Attachment,
  { isUrlUsable }: AttachmentRenderPolicyOptions,
): AttachmentRenderSource[] {
  const sources: AttachmentRenderSource[] = [];
  const displaySource = buildDisplaySource([
    getUsableVariant(attachment, 'medium', isUrlUsable),
    getUsableVariant(attachment, 'large', isUrlUsable),
  ], VIEWER_IMAGE_SIZES) || getLegacyDisplaySource(attachment, isUrlUsable);
  if (displaySource) sources.push(displaySource);

  const originalSource = getOriginalSource(
    attachment,
    displaySource?.url || '',
    isUrlUsable,
  );
  if (originalSource) sources.push(originalSource);
  return sources;
}

export function getAttachmentRenderIdentity(attachment: Attachment): string {
  if (attachment.id?.trim()) {
    return `id:${attachment.id.trim().toLowerCase()}`;
  }
  if (attachment.fallback_url?.trim()) {
    return `fallback:${attachment.fallback_url.trim()}`;
  }

  try {
    const parsed = new URL(attachment.url, 'https://attachment.invalid');
    return `path:${parsed.origin}${parsed.pathname}`;
  } catch {
    return `attachment:${attachment.url}`;
  }
}
