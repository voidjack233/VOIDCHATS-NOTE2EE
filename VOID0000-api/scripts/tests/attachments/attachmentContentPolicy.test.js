import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { sanitizeChatAttachmentImage } from '../../../server/utils/chatImageSanitizer.js';
import {
  createAttachmentObjectMetadata,
  createAttachmentStoragePolicy,
  createPresignedAttachmentResponseParams,
  resolveStoredAttachmentPolicy,
  sanitizeAttachmentFilename,
} from '../../../server/utils/attachmentContentPolicy.js';
import { createAttachmentDeliveryMapper } from '../../../server/utils/attachmentDeliveryCore.js';
import { transformVmdImage } from '../../../server/vmd/imageVariants.js';

const html = Buffer.from('<!doctype html><script src="/uploaded.js"></script>');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

test('ordinary and active content is forced to an octet-stream download', async () => {
  const ordinaryResult = await sanitizeChatAttachmentImage(html, 'text/html');
  assert.equal(ordinaryResult, null);

  const policy = createAttachmentStoragePolicy({
    sanitizedImage: ordinaryResult,
    originalName: 'payload.html',
  });
  assert.equal(policy.inline, false);
  assert.equal(policy.contentType, 'application/octet-stream');
  assert.equal(policy.contentDisposition, 'attachment; filename="payload.html"');

  const metadata = createAttachmentObjectMetadata(policy);
  assert.equal(metadata['Content-Type'], 'application/octet-stream');
  assert.equal(metadata['Content-Disposition'], 'attachment; filename="payload.html"');
});

test('HTML claiming to be PNG and SVG cannot enter the inline image path', async () => {
  await assert.rejects(
    sanitizeChatAttachmentImage(html, 'image/png'),
    { code: 'ATTACHMENT_IMAGE_INVALID' },
  );
  await assert.rejects(
    sanitizeChatAttachmentImage(svg, 'image/svg+xml'),
    { code: 'ATTACHMENT_IMAGE_UNSUPPORTED' },
  );
});

test('sanitized JPEG, PNG, and WebP remain inline and usable by VMD', async (t) => {
  for (const format of ['jpeg', 'png', 'webp']) {
    await t.test(format, async () => {
      const source = await sharp({
        create: {
          width: 12,
          height: 8,
          channels: 3,
          background: '#167d6b',
        },
      })[format]().toBuffer();
      const sanitized = await sanitizeChatAttachmentImage(source, `image/${format}`);
      const policy = createAttachmentStoragePolicy({
        sanitizedImage: sanitized,
        originalName: `photo.${format}`,
      });

      assert.equal(policy.inline, true);
      assert.equal(policy.contentType, format === 'jpeg' ? 'image/jpeg' : `image/${format}`);

      const transformed = await transformVmdImage(sanitized.buffer, 'thumb');
      assert.equal(transformed.contentType, 'image/webp');
      assert.ok(transformed.body.length > 0);
    });
  }
});

test('stored and signed active content is always forced to download', () => {
  const stored = resolveStoredAttachmentPolicy({
    metaData: {
      'content-type': 'text/html',
      'content-disposition': 'inline',
      'x-amz-meta-original-filename': 'page.html',
      'x-amz-meta-void-sanitized-image': '1',
    },
  }, 'conversation/object.bin');
  assert.equal(stored.contentType, 'application/octet-stream');
  assert.equal(stored.contentDisposition, 'attachment; filename="page.html"');

  const signed = createPresignedAttachmentResponseParams({
    metaData: {
      'content-type': 'application/javascript',
      'content-disposition': 'inline',
      'x-amz-meta-original-filename': 'payload.js',
    },
  }, 'conversation/object.bin');
  assert.equal(signed['response-content-type'], 'application/octet-stream');
  assert.equal(
    signed['response-content-disposition'],
    'attachment; filename="payload.js"',
  );
});

test('attachment filenames cannot inject headers or retain path components', () => {
  const filename = sanitizeAttachmentFilename('../../evil"\r\nX-Evil: yes.html');
  assert.equal(filename, 'evil___X-Evil: yes.html');
  assert.doesNotMatch(filename, /[\r\n"\\/]/);
});

test('signed-original generation is not given client-controlled descriptor metadata', async () => {
  const attachmentId = '11111111-1111-4111-8111-111111111111';
  let receivedArguments;
  const attachDelivery = createAttachmentDeliveryMapper({
    async queryAttachmentObjects() {
      return [{ id: attachmentId, object_key: `conversation/${attachmentId}.bin` }];
    },
    async createOriginalDelivery(...args) {
      receivedArguments = args;
      return { url: 'https://cdn.invalid/signed', url_expires_at: Date.now() + 60_000 };
    },
  });

  await attachDelivery([{
    attachments: [JSON.stringify({
      url: `/api/conversations/123/attachments/${attachmentId}`,
      mime: 'text/html',
      name: 'page.html',
    })],
  }], 'conversation-id');

  assert.deepEqual(receivedArguments, [`conversation/${attachmentId}.bin`]);
});
