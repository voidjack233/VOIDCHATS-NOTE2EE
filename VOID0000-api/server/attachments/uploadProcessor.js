import { randomUUID } from 'node:crypto';

export function createAttachmentUploadProcessor({
  sanitizeImage,
  createStoragePolicy,
  createObjectMetadata,
  lifecycle,
  createId = randomUUID,
} = {}) {
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
  }) {
    await lifecycle.assertUploadAllowed({
      userId,
      incomingCount: files.length,
      incomingBytes: files.reduce((total, file) => total + file.buffer.length, 0),
    });

    const preparedFiles = [];
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
