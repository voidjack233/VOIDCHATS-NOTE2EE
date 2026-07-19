import { getCachedAttachmentObjectUrl } from './attachmentService';
import { parseAttachments } from './messageAttachments';
import { getMessageById } from './messageService';
import type { Attachment, Message } from './chatTypes';

const messageCapabilityRefreshRequests = new Map<string, Promise<Message | null>>();

interface AttachmentRecoveryOptions {
  conversationId?: string | null;
  messageId?: string | null;
}

export interface RefreshedAttachmentDelivery {
  attachment: Attachment;
  url: string;
  urlExpiresAt?: number;
}

async function refreshMessageCapabilities(
  conversationId: string,
  messageId: string,
): Promise<Message | null> {
  const requestKey = `${conversationId}:${messageId}`;
  const existingRequest = messageCapabilityRefreshRequests.get(requestKey);
  if (existingRequest) return existingRequest;

  const request = getMessageById(conversationId, messageId);
  messageCapabilityRefreshRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (messageCapabilityRefreshRequests.get(requestKey) === request) {
      messageCapabilityRefreshRequests.delete(requestKey);
    }
  }
}

export async function refreshAttachmentFromMessage(
  attachment: Attachment,
  options?: AttachmentRecoveryOptions,
): Promise<RefreshedAttachmentDelivery> {
  const conversationId = options?.conversationId?.trim();
  const messageId = options?.messageId?.trim();
  const attachmentId = attachment.id?.trim();
  if (!conversationId || !messageId || !attachmentId) {
    throw new Error('Attachment message recovery identity is unavailable');
  }

  const refreshedMessage = await refreshMessageCapabilities(conversationId, messageId);
  if (!refreshedMessage) {
    throw new Error('Attachment message is unavailable');
  }

  const refreshedAttachment = parseAttachments(refreshedMessage.attachments)
    .find((candidate) => candidate.id === attachmentId);
  if (!refreshedAttachment) {
    throw new Error('Attachment is no longer available on this message');
  }

  const url = getCachedAttachmentObjectUrl(refreshedAttachment);
  if (!url) {
    throw new Error('Message did not return a usable attachment delivery URL');
  }

  return {
    attachment: refreshedAttachment,
    url,
    urlExpiresAt: refreshedAttachment.url_expires_at,
  };
}
