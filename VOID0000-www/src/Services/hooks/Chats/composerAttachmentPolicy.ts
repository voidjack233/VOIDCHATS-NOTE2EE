import { parseAttachment } from '../../Chat/messageAttachments';

interface PendingComposerAttachment {
  id: string;
  uploading: boolean;
  url: string | null;
}

interface AttachmentCleanupOptions {
  conversationId: string;
  deleteStaged: (conversationId: string, rawAttachment: string) => Promise<void>;
  pendingAttachments: PendingComposerAttachment[];
  removedUploadingIds: Set<string>;
  storedMessageAttachments?: string[];
}

interface CompletedUploadCleanupOptions {
  attachmentId: string;
  conversationId: string;
  deleteStaged: (conversationId: string, rawAttachment: string) => Promise<void>;
  editModeActive: boolean;
  removedUploadingIds: Set<string>;
  storedMessageAttachments?: string[];
  uploadedUrl: string | null | undefined;
}

const ATTACHMENT_ID_PATTERN =
  /\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/|$)/i;

function getAttachmentIdentity(rawAttachment: string): string {
  const attachment = parseAttachment(rawAttachment);
  const explicitId = attachment.id?.trim().toLowerCase();
  if (explicitId) {
    return `id:${explicitId}`;
  }

  const stableUrl = attachment.fallback_url?.trim() || attachment.url.trim();
  try {
    const pathname = new URL(stableUrl, 'https://attachment.invalid').pathname;
    const matchedId = pathname.match(ATTACHMENT_ID_PATTERN)?.[1]?.toLowerCase();
    return matchedId ? `id:${matchedId}` : `url:${stableUrl}`;
  } catch {
    return `url:${stableUrl}`;
  }
}

function createStoredAttachmentIdentities(rawAttachments: string[] = []): Set<string> {
  return new Set(rawAttachments.map(getAttachmentIdentity));
}

export function canStartComposerAttachmentUpload({
  attachmentsAllowed,
  editingMessageActive,
}: {
  attachmentsAllowed: boolean;
  editingMessageActive: boolean;
}): boolean {
  return attachmentsAllowed && !editingMessageActive;
}

export async function cleanupPendingComposerAttachmentsForEdit({
  conversationId,
  deleteStaged,
  pendingAttachments,
  removedUploadingIds,
  storedMessageAttachments = [],
}: AttachmentCleanupOptions): Promise<void> {
  const storedIdentities = createStoredAttachmentIdentities(storedMessageAttachments);
  const deletions: Promise<void>[] = [];

  for (const attachment of pendingAttachments) {
    if (attachment.uploading) {
      removedUploadingIds.add(attachment.id);
      continue;
    }
    if (
      attachment.url &&
      !storedIdentities.has(getAttachmentIdentity(attachment.url))
    ) {
      deletions.push(
        deleteStaged(conversationId, attachment.url).catch(() => {}),
      );
    }
  }

  await Promise.all(deletions);
}

export async function discardCompletedComposerUpload({
  attachmentId,
  conversationId,
  deleteStaged,
  editModeActive,
  removedUploadingIds,
  storedMessageAttachments = [],
  uploadedUrl,
}: CompletedUploadCleanupOptions): Promise<boolean> {
  const wasRemoved = removedUploadingIds.delete(attachmentId);
  if (!editModeActive && !wasRemoved) {
    return false;
  }

  if (uploadedUrl) {
    const storedIdentities = createStoredAttachmentIdentities(storedMessageAttachments);
    if (!storedIdentities.has(getAttachmentIdentity(uploadedUrl))) {
      await deleteStaged(conversationId, uploadedUrl).catch(() => {});
    }
  }
  return true;
}
