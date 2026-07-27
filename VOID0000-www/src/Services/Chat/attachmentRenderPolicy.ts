import type { Attachment } from './chatTypes';

export interface AttachmentRenderSource {
  kind: 'display' | 'original';
  url: string;
}

interface AttachmentRenderPolicyOptions {
  isUrlUsable: (url: string, expiresAt?: number) => boolean;
}

export function resolveAttachmentRenderSources(
  attachment: Attachment,
  { isUrlUsable }: AttachmentRenderPolicyOptions,
): AttachmentRenderSource[] {
  const sources: AttachmentRenderSource[] = [];
  const displayUrl = attachment.display_url?.trim() || '';

  if (
    displayUrl &&
    isUrlUsable(displayUrl, attachment.display_url_expires_at)
  ) {
    sources.push({ kind: 'display', url: displayUrl });
  }

  if (
    attachment.inline === true &&
    attachment.url !== displayUrl &&
    isUrlUsable(attachment.url, attachment.url_expires_at)
  ) {
    sources.push({ kind: 'original', url: attachment.url });
  }

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
