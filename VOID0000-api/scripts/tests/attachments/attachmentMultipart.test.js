import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  ATTACHMENT_MULTIPART_LIMITS,
  parseAttachmentMultipartRequest,
} from '../../../server/attachments/multipart.js';
import { createAttachmentUploadProcessor } from '../../../server/attachments/uploadProcessor.js';
import {
  createAttachmentObjectMetadata,
  createAttachmentStoragePolicy,
} from '../../../server/utils/attachmentContentPolicy.js';
import {
  AttachmentSanitizerTransportError,
  ChatImageSanitizationError,
} from '../../../server/utils/chatImageErrors.js';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function buildMultipartBody({
  files = [],
  metadata = files.map((file) => ({
    name: file.filename,
    mime: file.mimeType,
    size: file.bytes.length,
  })),
  fields = [],
  boundary = 'void-attachment-test-boundary',
  includeClosingBoundary = true,
} = {}) {
  const chunks = [];
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.fieldName || 'files'}"; filename="${file.filename || 'attachment'}"\r\n` +
      `Content-Type: ${file.mimeType || 'application/octet-stream'}\r\n\r\n`,
    ));
    chunks.push(file.bytes);
    chunks.push(Buffer.from('\r\n'));
  }
  for (const field of fields) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field.name}"\r\n\r\n` +
      `${field.value}\r\n`,
    ));
  }
  if (metadata !== undefined) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="metadata"\r\n\r\n' +
      `${typeof metadata === 'string' ? metadata : JSON.stringify(metadata)}\r\n`,
    ));
  }
  if (includeClosingBoundary) {
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
  }
  return {
    body: Buffer.concat(chunks),
    boundary,
  };
}

function createMultipartRequest(options = {}) {
  const { body, boundary } = buildMultipartBody(options);
  const request = Readable.from([body]);
  request.headers = {
    'content-type': options.contentType || `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
  };
  return { request, body };
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
      stagedRows.push(...input.attachments.map((attachment) => ({
        ...attachment,
        status: 'staged',
        userId: input.userId,
        conversationId: input.conversationId,
      })));
    },
  };
  const objectStore = {
    async putObject(bucket, objectKey, buffer, size, metadata) {
      storedObjects.push({
        bucket,
        objectKey,
        buffer: Buffer.from(buffer),
        size,
        metadata,
      });
    },
    async removeObject() {},
  };
  const processor = createAttachmentUploadProcessor({
    sanitizeImage: sanitizeImage || (async () => null),
    createStoragePolicy: createAttachmentStoragePolicy,
    createObjectMetadata: createAttachmentObjectMetadata,
    objectStore,
    lifecycle,
    bucket: 'chat-attachments',
    createId: () => ATTACHMENT_ID,
    logger: { error() {} },
  });

  return {
    lifecycle,
    objectStore,
    processor,
    quotaCalls,
    stagedRows,
    storedObjects,
  };
}

test('multipart parser preserves exact image bytes and bounded client metadata', async () => {
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x0d, 0x0a, 0x80, 0x01]);
  const { request } = createMultipartRequest({
    files: [{
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      bytes,
    }],
    metadata: [{
      name: 'photo.jpg',
      mime: 'image/jpeg',
      size: bytes.length,
      width: 640,
      height: 480,
      blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    }],
  });

  const result = await parseAttachmentMultipartRequest(request);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0].buffer, bytes);
  assert.deepEqual(result.files[0].metadata, {
    name: 'photo.jpg',
    mime: 'image/jpeg',
    size: bytes.length,
    width: 640,
    height: 480,
    blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
  });
});

test('successful multipart image upload sanitizes, marks, stages, and preserves response shape', async () => {
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
  assert.deepEqual(harness.stagedRows, [{
    id: ATTACHMENT_ID,
    objectKey: `${CONVERSATION_ID}/${ATTACHMENT_ID}.bin`,
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

test('permitted non-image upload keeps exact bytes and cannot receive the trusted marker', async () => {
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

test('multipart parser accepts five files and rejects a sixth', async () => {
  const fiveFiles = Array.from({ length: 5 }, (_, index) => ({
    filename: `file-${index}.bin`,
    mimeType: 'application/octet-stream',
    bytes: Buffer.from([index + 1]),
  }));
  const accepted = createMultipartRequest({ files: fiveFiles });
  assert.equal(
    (await parseAttachmentMultipartRequest(accepted.request)).files.length,
    5,
  );

  const rejected = createMultipartRequest({
    files: [...fiveFiles, {
      filename: 'file-6.bin',
      mimeType: 'application/octet-stream',
      bytes: Buffer.from([6]),
    }],
  });
  await assert.rejects(
    parseAttachmentMultipartRequest(rejected.request),
    { code: 'ATTACHMENT_FILE_LIMIT_EXCEEDED' },
  );
});

test('multipart parser enforces the per-file byte limit while streaming', async () => {
  const { request } = createMultipartRequest({
    files: [{
      filename: 'too-large.bin',
      mimeType: 'application/octet-stream',
      bytes: Buffer.alloc(ATTACHMENT_MULTIPART_LIMITS.maxFileBytes + 1, 0x61),
    }],
  });

  await assert.rejects(
    parseAttachmentMultipartRequest(request),
    { code: 'ATTACHMENT_TOO_LARGE', status: 413 },
  );
});

test('multipart parser enforces a total request byte limit independent of content length', async () => {
  const { body, boundary } = buildMultipartBody({
    files: [{
      filename: 'bounded.bin',
      mimeType: 'application/octet-stream',
      bytes: Buffer.alloc(128, 0x62),
    }],
  });
  const request = Readable.from([
    body.subarray(0, 48),
    body.subarray(48),
  ]);
  request.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
  };

  await assert.rejects(
    parseAttachmentMultipartRequest(request, {
      limits: {
        ...ATTACHMENT_MULTIPART_LIMITS,
        maxTotalBytes: 64,
      },
    }),
    { code: 'ATTACHMENT_REQUEST_TOO_LARGE', status: 413 },
  );
});

test('multipart parser rejects malformed requests, missing files, and unexpected file fields', async (t) => {
  await t.test('obsolete JSON upload body', async () => {
    const body = Buffer.from(JSON.stringify({
      files: [{ data: Buffer.from('legacy').toString('base64') }],
    }));
    const request = Readable.from([body]);
    request.headers = {
      'content-type': 'application/json',
      'content-length': String(body.length),
    };
    await assert.rejects(
      parseAttachmentMultipartRequest(request),
      { code: 'ATTACHMENT_MULTIPART_INVALID' },
    );
  });

  await t.test('malformed closing boundary', async () => {
    const { request } = createMultipartRequest({
      files: [{
        filename: 'broken.bin',
        mimeType: 'application/octet-stream',
        bytes: Buffer.from('broken'),
      }],
      includeClosingBoundary: false,
    });
    await assert.rejects(
      parseAttachmentMultipartRequest(request),
      { code: 'ATTACHMENT_MULTIPART_INVALID' },
    );
  });

  await t.test('missing file field', async () => {
    const { request } = createMultipartRequest({
      files: [],
      metadata: [],
    });
    await assert.rejects(
      parseAttachmentMultipartRequest(request),
      { code: 'ATTACHMENT_FILES_REQUIRED' },
    );
  });

  await t.test('unexpected file field', async () => {
    const { request } = createMultipartRequest({
      files: [{
        fieldName: 'avatar',
        filename: 'unexpected.bin',
        mimeType: 'application/octet-stream',
        bytes: Buffer.from('unexpected'),
      }],
    });
    await assert.rejects(
      parseAttachmentMultipartRequest(request),
      { code: 'ATTACHMENT_FILE_FIELD_INVALID' },
    );
  });
});

test('multipart parser rejects oversized and structurally invalid metadata', async (t) => {
  await t.test('oversized metadata field', async () => {
    const { request } = createMultipartRequest({
      files: [{
        filename: 'file.bin',
        mimeType: 'application/octet-stream',
        bytes: Buffer.from('file'),
      }],
      metadata: JSON.stringify([{
        name: 'x'.repeat(ATTACHMENT_MULTIPART_LIMITS.maxMetadataBytes),
      }]),
    });
    await assert.rejects(
      parseAttachmentMultipartRequest(request),
      { code: 'ATTACHMENT_METADATA_TOO_LARGE' },
    );
  });

  await t.test('metadata count mismatch', async () => {
    const { request } = createMultipartRequest({
      files: [{
        filename: 'file.bin',
        mimeType: 'application/octet-stream',
        bytes: Buffer.from('file'),
      }],
      metadata: [],
    });
    await assert.rejects(
      parseAttachmentMultipartRequest(request),
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
