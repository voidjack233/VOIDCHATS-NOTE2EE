import type { Attachment } from './chatTypes';

export function parseAttachment(raw: string): Attachment {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.url === 'string') {
      return parsed as Attachment;
    }
  } catch {
    // Fall back to the raw URL format.
  }

  return { url: raw };
}

export function parseAttachments(raws?: string[]): Attachment[] {
  return (raws || []).map(parseAttachment);
}

export function serializeAttachment(attachment: Attachment): string {
  const {
    fallback_url: fallbackUrl,
    url_expires_at: _urlExpiresAt,
    ...stableAttachment
  } = attachment;
  void _urlExpiresAt;
  stableAttachment.url = fallbackUrl?.trim() || attachment.url;

  const normalizedEntries = Object.entries(stableAttachment)
    .filter(([, value]) => value !== undefined);
  if (normalizedEntries.length === 1 && typeof stableAttachment.url === 'string') {
    return stableAttachment.url;
  }

  return JSON.stringify(stableAttachment);
}

export function serializeAttachments(attachments: Attachment[]): string[] {
  return attachments.map(serializeAttachment);
}
