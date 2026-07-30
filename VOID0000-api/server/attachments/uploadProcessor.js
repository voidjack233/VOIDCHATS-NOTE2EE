import { randomUUID } from 'node:crypto';

export function createAttachmentUploadProcessor({
  sanitizeImage,
  createStoragePolicy,
  createObjectMetadata,
  objectStore,
  lifecycle,
  bucket,
  createId = randomUUID,
  logger = console,
} = {}) {
  if (typeof sanitizeImage !== 'function') {
    throw new TypeError('Attachment upload processor requires a sanitizer');
  }
  if (typeof createStoragePolicy !== 'function' || typeof createObjectMetadata !== 'function') {
    throw new TypeError('Attachment upload processor requires a storage policy');
  }
  if (
    !objectStore ||
    typeof objectStore.putObject !== 'function' ||
    typeof objectStore.removeObject !== 'function'
  ) {
    throw new TypeError('Attachment upload processor requires an object store');
  }
  if (
    !lifecycle ||
    typeof lifecycle.assertUploadAllowed !== 'function' ||
    typeof lifecycle.stageUploadedAttachments !== 'function'
  ) {
    throw new TypeError('Attachment upload processor requires an attachment lifecycle');
  }
  if (typeof bucket !== 'string' || !bucket) {
    throw new TypeError('Attachment upload processor requires a storage bucket');
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
        buffer: Buffer.isBuffer(sanitizedImage?.buffer)
          ? sanitizedImage.buffer
          : file.buffer,
        ...contentPolicy,
        width: sanitizedImage?.width,
        height: sanitizedImage?.height,
      });
    }

    const storedAttachments = [];
    try {
      for (const prepared of preparedFiles) {
        const attachmentId = createId();
        const objectKey = `${conversation.id}/${attachmentId}.bin`;

        await objectStore.putObject(
          bucket,
          objectKey,
          prepared.buffer,
          prepared.buffer.length,
          createObjectMetadata(prepared),
        );
        storedAttachments.push({
          ...prepared,
          attachmentId,
          objectKey,
        });
      }

      await lifecycle.stageUploadedAttachments({
        userId,
        conversationId: conversation.id,
        attachments: storedAttachments.map((attachment) => ({
          id: attachment.attachmentId,
          objectKey: attachment.objectKey,
          sizeBytes: attachment.buffer.length,
        })),
      });
    } catch (error) {
      const cleanupResults = await Promise.allSettled(
        storedAttachments.map((attachment) => (
          objectStore.removeObject(bucket, attachment.objectKey)
        )),
      );
      cleanupResults.forEach((result) => {
        if (result.status === 'rejected') {
          logger.error('Attachment object cleanup error:', result.reason);
        }
      });
      throw error;
    }

    const attachments = storedAttachments.map((attachment) => ({
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
