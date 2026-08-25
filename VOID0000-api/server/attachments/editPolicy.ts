const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PROTECTED_ATTACHMENT_PATH_PATTERN = new RegExp(
  `^/api/conversations/[^/?#]+/attachments/(${UUID_SOURCE})/?$`,
  'i',
);

function isDescriptor(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class MessageEditAttachmentError extends Error {
  readonly status = 409;
  readonly code = 'MESSAGE_EDIT_ATTACHMENTS_IMMUTABLE';
  readonly body: { error: string; code: string };

  constructor(message: string = 'Message attachments cannot be changed during editing') {
    super(message);
    this.name = 'MessageEditAttachmentError';
    this.body = {
      error: message,
      code: this.code,
    };
  }
}

function parseDescriptor(rawAttachment: unknown): Record<string, unknown> | null {
  if (typeof rawAttachment !== 'string') {
    return null;
  }

  const raw = rawAttachment.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isDescriptor(parsed)) {
      return parsed;
    }
  } catch {
    // Existing attachment rows can contain a plain URL.
  }

  return { url: raw };
}

function getAttachmentIdentity(rawAttachment: unknown): string {
  const descriptor = parseDescriptor(rawAttachment);
  if (!descriptor) {
    return `invalid:${String(rawAttachment)}`;
  }

  const stableUrl = typeof descriptor.fallback_url === 'string' &&
    descriptor.fallback_url.trim()
    ? descriptor.fallback_url.trim()
    : typeof descriptor.url === 'string'
      ? descriptor.url.trim()
      : '';

  if (!stableUrl) {
    return `invalid:${String(rawAttachment)}`;
  }

  try {
    const pathname = new URL(stableUrl, 'https://attachment.invalid').pathname;
    const match = pathname.match(PROTECTED_ATTACHMENT_PATH_PATTERN);
    if (match?.[1]) {
      return `protected:${match[1].toLowerCase()}`;
    }
  } catch {
    // Non-URL historical values remain comparable without becoming trusted.
  }

  return `legacy:${stableUrl}`;
}

function getSortedAttachmentIdentities(attachments: readonly unknown[]): string[] {
  return attachments.map(getAttachmentIdentity).sort();
}

export function preserveMessageEditAttachments(
  storedAttachments: unknown,
  submittedAttachments: unknown,
): unknown[] {
  const existing = Array.isArray(storedAttachments)
    ? [...storedAttachments]
    : [];

  if (submittedAttachments === undefined) {
    return existing;
  }
  if (!Array.isArray(submittedAttachments)) {
    throw new MessageEditAttachmentError();
  }

  const storedIdentities = getSortedAttachmentIdentities(existing);
  const submittedIdentities = getSortedAttachmentIdentities(submittedAttachments);
  const matches = storedIdentities.length === submittedIdentities.length &&
    storedIdentities.every((identity, index) => (
      identity === submittedIdentities[index]
    ));

  if (!matches) {
    throw new MessageEditAttachmentError();
  }

  return existing;
}
