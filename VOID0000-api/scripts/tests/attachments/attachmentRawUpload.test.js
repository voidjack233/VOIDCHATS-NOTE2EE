import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  ATTACHMENT_RAW_UPLOAD_LIMITS,
  parseAttachmentRawRequest,
} from '../../../server/attachments/rawUpload.js';
import { createAttachmentUploadProcessor } from '../../../server/attachments/uploadProcessor.js';
import {
  createAttachmentBlobMetadata,
  createAttachmentStoragePolicy,
} from '../../../server/utils/attachmentContentPolicy.js';
import {
  AttachmentSanitizerTransportError,
  ChatImageSanitizationError,
} from '../../../server/utils/chatImageErrors.js';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function createRawRequest(bytes, headers = {}) {
  const request = Readable.from([bytes]);
  request.headers = {
    'content-type': 'application/octet-stream',
    'content-length': String(bytes.length),
    ...headers,
  };
  return request;
}

function createUploadHarness({ sanitizeImage } = {}) {
  const storedObjects = [];
  const stagedRows = [];
  const quotaCalls = [];
  const lifecycle = {
    async assertUploadAllowed(input) {
      quotaCalls.push(input);
    },
    async stageUploadedAttachments(input) {
      stagedRows.push(...input.attachments.map((attachment) => {
        storedObjects.push({
          buffer: Buffer.from(attachment.buffer),
          size: attachment.buffer.length,
          metadata: attachment.objectMetadata,
        });
        return {
          id: attachment.id,
          filename: attachment.filename,
          contentType: attachment.contentType,
          inline: attachment.inline,
          sizeBytes: attachment.buffer.length,
          status: 'staged',
          userId: input.userId,
          conversationId: input.conversationId,
        };
      }));
    },
  };
  const processor = createAttachmentUploadProcessor({
    sanitizeImage: sanitizeImage || (async () => null),
    createStoragePolicy: createAttachmentStoragePolicy,
    createObjectMetadata: createAttachmentBlobMetadata,
    lifecycle,
    createId: () => ATTACHMENT_ID,
  });

  return {
    processor,
    quotaCalls,
    stagedRows,
    storedObjects,
  };
}

test('raw parser preserves exact bytes and validates bounded metadata headers', async () => {
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x0d, 0x0a, 0x80, 0x01]);
  const request = createRawRequest(bytes, {
    'x-attachment-filename': encodeURIComponent('photo.jpg'),
    'x-attachment-mime': 'image/jpeg',
    'x-attachment-width': '640',
    'x-attachment-height': '480',
    'x-attachment-blurhash': 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
  });

  const result = await parseAttachmentRawRequest(request);
  assert.deepEqual(result.file.buffer, bytes);
  assert.equal(result.file.clientFilename, 'photo.jpg');
  assert.equal(result.file.clientMimeType, 'image/jpeg');
  assert.deepEqual(result.file.metadata, {
    name: 'photo.jpg',
    mime: 'image/jpeg',
    size: bytes.length,
    width: 640,
    height: 480,
    blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
  });
});

test('raw image upload sanitizes, marks, stages, and preserves response shape', async () => {
  const originalBytes = Buffer.from('original-image-bytes');
  const sanitizedBytes = Buffer.from('sanitized-image-bytes');
  let sanitizerInput;
  const harness = createUploadHarness({
    sanitizeImage: async (buffer, claimedMimeType) => {
      sanitizerInput = {
        buffer: Buffer.from(buffer),
        claimedMimeType,
      };
      return {
        buffer: sanitizedBytes,
        contentType: 'image/png',
        width: 320,
        height: 200,
      };
    },
  });

  const response = await harness.processor({
    userId: USER_ID,
    conversation: {
      id: CONVERSATION_ID,
      public_id: '732434999193640960',
    },
    files: [{
      buffer: originalBytes,
      clientFilename: '../../untrusted.jpg',
      clientMimeType: 'image/jpeg',
      metadata: {
        name: 'photo.jpg',
        mime: 'image/jpeg',
        size: originalBytes.length,
      },
    }],
    buildPrivateUrl: (_conversation, attachmentId) => (
      `/api/conversations/732434999193640960/attachments/${attachmentId}`
    ),
  });

  assert.deepEqual(sanitizerInput.buffer, originalBytes);
  assert.equal(sanitizerInput.claimedMimeType, 'image/jpeg');
  assert.deepEqual(harness.storedObjects[0].buffer, sanitizedBytes);
  assert.equal(
    harness.storedObjects[0].metadata['X-Amz-Meta-Void-Sanitized-Image'],
    '1',
  );
  assert.deepEqual(harness.quotaCalls, [{
    userId: USER_ID,
    incomingCount: 1,
    incomingBytes: originalBytes.length,
  }]);
  assert.deepEqual(harness.stagedRows, [{
    id: ATTACHMENT_ID,
    filename: 'photo.jpg',
    contentType: 'image/png',
    inline: true,
    sizeBytes: sanitizedBytes.length,
    status: 'staged',
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
  }]);
  assert.deepEqual(response, {
    success: true,
    conversation_id: CONVERSATION_ID,
    conversation_public_id: '732434999193640960',
    urls: [
      `/api/conversations/732434999193640960/attachments/${ATTACHMENT_ID}`,
    ],
    blurhashes: [''],
    attachments: [{
      url: `/api/conversations/732434999193640960/attachments/${ATTACHMENT_ID}`,
      mime: 'image/png',
      size: sanitizedBytes.length,
      width: 320,
      height: 200,
    }],
  });
});

test('permitted non-image raw upload preserves exact bytes and remains non-inline', async () => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  let sanitizerBytes;
  const harness = createUploadHarness({
    sanitizeImage: async (buffer) => {
      sanitizerBytes = Buffer.from(buffer);
      return null;
    },
  });

  const response = await harness.processor({
    userId: USER_ID,
    conversation: { id: CONVERSATION_ID, public_id: null },
    files: [{
      buffer: bytes,
      clientFilename: 'archive.zip',
      clientMimeType: 'application/zip',
      metadata: {
        name: 'archive.zip',
        mime: 'application/zip',
        size: bytes.length,
      },
    }],
    buildPrivateUrl: (_conversation, attachmentId) => (
      `/api/conversations/${CONVERSATION_ID}/attachments/${attachmentId}`
    ),
  });

  assert.deepEqual(sanitizerBytes, bytes);
  assert.deepEqual(harness.storedObjects[0].buffer, bytes);
  assert.equal(
    harness.storedObjects[0].metadata['X-Amz-Meta-Void-Sanitized-Image'],
    '0',
  );
  assert.equal(response.attachments[0].mime, 'application/octet-stream');
  assert.equal(harness.stagedRows[0].status, 'staged');
});

test('raw parser enforces the 10 MiB limit before and during streaming', async (t) => {
  await t.test('declared length is too large', async () => {
    const request = createRawRequest(Buffer.from('small'), {
      'content-length': String(ATTACHMENT_RAW_UPLOAD_LIMITS.maxFileBytes + 1),
    });
    await assert.rejects(
      parseAttachmentRawRequest(request),
      { code: 'ATTACHMENT_TOO_LARGE', status: 413 },
    );
  });

  await t.test('chunked body crosses the streaming limit', async () => {
    const request = createRawRequest(Buffer.alloc(65, 0x61));
    delete request.headers['content-length'];
    await assert.rejects(
      parseAttachmentRawRequest(request, {
        limits: {
          ...ATTACHMENT_RAW_UPLOAD_LIMITS,
          maxFileBytes: 64,
        },
      }),
      { code: 'ATTACHMENT_TOO_LARGE', status: 413 },
    );
  });
});

test('raw parser rejects non-binary, empty, and inconsistent request bodies', async (t) => {
  await t.test('non-binary content type', async () => {
    const request = createRawRequest(Buffer.from('{}'), {
      'content-type': 'application/json',
    });
    await assert.rejects(
      parseAttachmentRawRequest(request),
      { code: 'ATTACHMENT_BINARY_CONTENT_TYPE_REQUIRED', status: 415 },
    );
  });

  await t.test('empty body', async () => {
    const request = createRawRequest(Buffer.alloc(0));
    await assert.rejects(
      parseAttachmentRawRequest(request),
      { code: 'ATTACHMENT_EMPTY' },
    );
  });

  await t.test('declared length mismatch', async () => {
    const request = createRawRequest(Buffer.from('bytes'), {
      'content-length': '10',
    });
    await assert.rejects(
      parseAttachmentRawRequest(request),
      { code: 'ATTACHMENT_LENGTH_MISMATCH' },
    );
  });
});

test('raw parser rejects malformed or oversized client metadata', async (t) => {
  await t.test('malformed encoded filename', async () => {
    const request = createRawRequest(Buffer.from('file'), {
      'x-attachment-filename': '%E0%A4%A',
    });
    await assert.rejects(
      parseAttachmentRawRequest(request),
      { code: 'ATTACHMENT_METADATA_INVALID' },
    );
  });

  await t.test('oversized filename header', async () => {
    const request = createRawRequest(Buffer.from('file'), {
      'x-attachment-filename': 'x'.repeat(
        ATTACHMENT_RAW_UPLOAD_LIMITS.maxFilenameHeaderBytes + 1,
      ),
    });
    await assert.rejects(
      parseAttachmentRawRequest(request),
      { code: 'ATTACHMENT_METADATA_TOO_LARGE', status: 413 },
    );
  });

  await t.test('invalid dimensions', async () => {
    const request = createRawRequest(Buffer.from('file'), {
      'x-attachment-width': '-1',
    });
    await assert.rejects(
      parseAttachmentRawRequest(request),
      { code: 'ATTACHMENT_METADATA_INVALID' },
    );
  });

  await t.test('invalid MIME header', async () => {
    const request = createRawRequest(Buffer.from('file'), {
      'x-attachment-mime': 'image/jpeg\ntext/html',
    });
    await assert.rejects(
      parseAttachmentRawRequest(request),
      { code: 'ATTACHMENT_METADATA_INVALID' },
    );
  });
});

test('sanitizer rejection and transport failure stop before trusted storage', async (t) => {
  await t.test('sanitizer rejects image bytes', async () => {
    const harness = createUploadHarness({
      sanitizeImage: async () => {
        throw new ChatImageSanitizationError('Image is corrupt', {
          code: 'CHAT_IMAGE_CORRUPT',
          status: 400,
        });
      },
    });
    await assert.rejects(
      harness.processor({
        userId: USER_ID,
        conversation: { id: CONVERSATION_ID },
        files: [{
          buffer: Buffer.from('bad-image'),
          clientFilename: 'bad.jpg',
          clientMimeType: 'image/jpeg',
          metadata: {},
        }],
        buildPrivateUrl() {},
      }),
      { code: 'CHAT_IMAGE_CORRUPT', status: 400 },
    );
    assert.equal(harness.storedObjects.length, 0);
    assert.equal(harness.stagedRows.length, 0);
  });

  await t.test('sanitizer transport is unavailable', async () => {
    const harness = createUploadHarness({
      sanitizeImage: async () => {
        throw new AttachmentSanitizerTransportError('Worker unavailable', {
          code: 'ATTACHMENT_SANITIZER_UNAVAILABLE',
          status: 503,
          retryable: true,
        });
      },
    });
    await assert.rejects(
      harness.processor({
        userId: USER_ID,
        conversation: { id: CONVERSATION_ID },
        files: [{
          buffer: Buffer.from('image'),
          clientFilename: 'photo.jpg',
          clientMimeType: 'image/jpeg',
          metadata: {},
        }],
        buildPrivateUrl() {},
      }),
      {
        code: 'ATTACHMENT_SANITIZER_UNAVAILABLE',
        status: 503,
        retryable: true,
      },
    );
    assert.equal(harness.storedObjects.length, 0);
    assert.equal(harness.stagedRows.length, 0);
  });
});
