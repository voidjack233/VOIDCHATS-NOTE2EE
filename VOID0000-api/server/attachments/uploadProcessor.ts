import { randomUUID } from 'node:crypto';
import type { AttachmentStoragePolicy } from '../utils/attachmentContentPolicy.js';

interface SanitizedImageResult {
  buffer: Buffer;
  contentType: string;
  width?: number;
  height?: number;
}

interface AttachmentUploadFile {
  buffer: Buffer;
  clientMimeType: string;
  clientFilename: string;
  metadata?: {
    mime?: string;
    name?: string;
  };
}

interface AttachmentConversation {
  id: string;
  public_id?: unknown;
}

interface PreparedAttachment extends AttachmentStoragePolicy {
  attachmentId: string;
  buffer: Buffer;
  width?: number;
  height?: number;
}

interface UploadLifecycle {
  assertUploadAllowed(options: {
    userId: string;
    incomingCount: number;
    incomingBytes: number;
  }): Promise<unknown>;
  stageUploadedAttachments(options: {
    userId: string;
    conversationId: string;
    attachments: Array<{
      id: string;
      buffer: Buffer;
      filename: string;
      contentType: string;
      inline: boolean;
      objectMetadata: Record<string, string>;
    }>;
  }): Promise<unknown>;
}

interface AttachmentUploadProcessorOptions {
  sanitizeImage(
    buffer: Buffer,
    claimedMime: string,
  ): Promise<SanitizedImageResult | null>;
  createStoragePolicy(options: {
    sanitizedImage: SanitizedImageResult | null;
    originalName: unknown;
  }): Readonly<AttachmentStoragePolicy>;
  createObjectMetadata(policy: AttachmentStoragePolicy): Record<string, string>;
  lifecycle: UploadLifecycle;
  createId?: () => string;
}

interface ProcessAttachmentUploadOptions {
  userId: string;
  conversation: AttachmentConversation;
  files: AttachmentUploadFile[];
  buildPrivateUrl(conversation: AttachmentConversation, attachmentId: string): string;
}

export function createAttachmentUploadProcessor({
  sanitizeImage,
  createStoragePolicy,
  createObjectMetadata,
  lifecycle,
  createId = randomUUID,
}: Partial<AttachmentUploadProcessorOptions> = {}) {
  if (typeof sanitizeImage !== 'function') {
    throw new TypeError('Attachment upload processor requires a sanitizer');
  }
  if (typeof createStoragePolicy !== 'function' || typeof createObjectMetadata !== 'function') {
    throw new TypeError('Attachment upload processor requires a storage policy');
  }
  if (
    !lifecycle ||
    typeof lifecycle.assertUploadAllowed !== 'function' ||
    typeof lifecycle.stageUploadedAttachments !== 'function'
  ) {
    throw new TypeError('Attachment upload processor requires an attachment lifecycle');
  }
  return async function processAttachmentUpload({
    userId,
    conversation,
    files,
    buildPrivateUrl,
  }: ProcessAttachmentUploadOptions) {
    await lifecycle.assertUploadAllowed({
      userId,
      incomingCount: files.length,
      incomingBytes: files.reduce((total, file) => total + file.buffer.length, 0),
    });

    const preparedFiles: PreparedAttachment[] = [];
    for (const file of files) {
      const requestedContentType =
        file.metadata?.mime || file.clientMimeType || 'application/octet-stream';
      const sanitizedImage = await sanitizeImage(
        file.buffer,
        requestedContentType.slice(0, 255),
      );
      const contentPolicy = createStoragePolicy({
        sanitizedImage,
        originalName: file.metadata?.name || file.clientFilename,
      });

      preparedFiles.push({
        attachmentId: createId(),
        buffer: Buffer.isBuffer(sanitizedImage?.buffer)
          ? sanitizedImage.buffer
          : file.buffer,
        ...contentPolicy,
        width: sanitizedImage?.width,
        height: sanitizedImage?.height,
      });
    }

    await lifecycle.stageUploadedAttachments({
      userId,
      conversationId: conversation.id,
      attachments: preparedFiles.map((attachment) => ({
        id: attachment.attachmentId,
        buffer: attachment.buffer,
        filename: attachment.filename,
        contentType: attachment.contentType,
        inline: attachment.inline,
        objectMetadata: createObjectMetadata(attachment),
      })),
    });

    const attachments = preparedFiles.map((attachment) => ({
      url: buildPrivateUrl(conversation, attachment.attachmentId),
      mime: attachment.contentType,
      size: attachment.buffer.length,
      ...(attachment.width ? { width: attachment.width } : {}),
      ...(attachment.height ? { height: attachment.height } : {}),
    }));

    return {
      success: true,
      conversation_id: conversation.id,
      conversation_public_id: conversation.public_id
        ? String(conversation.public_id)
        : null,
      urls: attachments.map((attachment) => attachment.url),
      blurhashes: attachments.map(() => ''),
      attachments,
    };
  };
}
