import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { sanitizeChatAttachmentImage } from '../../../server/utils/chatImageSanitizer.js';
import {
  createAttachmentBlobMetadata,
  createAttachmentObjectMetadata,
  createProtectedAttachmentResponseHeaders,
  createAttachmentStoragePolicy,
  createPresignedAttachmentResponseParams,
  resolveStoredAttachmentPolicy,
  sanitizeAttachmentFilename,
} from '../../../server/utils/attachmentContentPolicy.js';
import {
  createAttachmentDeliveryMapper,
  normalizeStoredAttachments,
} from '../../../server/utils/attachmentDeliveryCore.js';
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

test('only the exact sanitizer marker permits approved raster images inline', () => {
  for (const contentType of ['image/jpeg', 'image/png']) {
    const policy = resolveStoredAttachmentPolicy({
      metaData: {
        'content-type': contentType,
        'x-amz-meta-void-sanitized-image': '1',
      },
    }, 'conversation/image.bin');
    assert.equal(policy.inline, true);
    assert.equal(policy.contentType, contentType);
    assert.match(policy.contentDisposition, /^inline;/);
  }

  for (const marker of [undefined, '0', 'unknown']) {
    const metadata = { 'content-type': 'image/jpeg' };
    if (marker !== undefined) {
      metadata['x-amz-meta-void-sanitized-image'] = marker;
    }
    const policy = resolveStoredAttachmentPolicy(
      { metaData: metadata },
      'conversation/legacy.jpg',
    );
    assert.equal(policy.inline, false);
    assert.equal(policy.contentType, 'application/octet-stream');
    assert.match(policy.contentDisposition, /^attachment;/);
  }
});

test('active image-like types never become inline regardless of marker', () => {
  for (const contentType of ['text/html', 'image/svg+xml']) {
    const policy = resolveStoredAttachmentPolicy({
      metaData: {
        'content-type': contentType,
        'x-amz-meta-void-sanitized-image': '1',
      },
    }, 'conversation/active.bin');
    assert.equal(policy.inline, false);
    assert.equal(policy.contentType, 'application/octet-stream');
    assert.match(policy.contentDisposition, /^attachment;/);
  }
});

test('protected and signed delivery apply the same strict marker policy', () => {
  const trustedImageStat = {
    metaData: {
      'content-type': 'image/jpeg',
      'x-amz-meta-void-sanitized-image': '1',
      'x-amz-meta-original-filename': 'trusted.jpg',
    },
  };
  const legacyImageStat = {
    metaData: {
      'content-type': 'image/jpeg',
      'x-amz-meta-original-filename': 'legacy.jpg',
    },
  };

  const protectedTrusted = createProtectedAttachmentResponseHeaders(
    trustedImageStat,
    'conversation/trusted.bin',
  );
  const signedTrusted = createPresignedAttachmentResponseParams(
    trustedImageStat,
    'conversation/trusted.bin',
  );
  assert.equal(protectedTrusted['Content-Type'], 'image/jpeg');
  assert.match(protectedTrusted['Content-Disposition'], /^inline;/);
  assert.equal(protectedTrusted['X-Content-Type-Options'], 'nosniff');
  assert.equal(signedTrusted['response-content-type'], 'image/jpeg');
  assert.match(signedTrusted['response-content-disposition'], /^inline;/);

  const protectedLegacy = createProtectedAttachmentResponseHeaders(
    legacyImageStat,
    'conversation/legacy.bin',
  );
  const signedLegacy = createPresignedAttachmentResponseParams(
    legacyImageStat,
    'conversation/legacy.bin',
  );
  assert.equal(protectedLegacy['Content-Type'], 'application/octet-stream');
  assert.match(protectedLegacy['Content-Disposition'], /^attachment;/);
  assert.equal(signedLegacy['response-content-type'], 'application/octet-stream');
  assert.match(signedLegacy['response-content-disposition'], /^attachment;/);
});

test('attachment filenames cannot inject headers or retain path components', () => {
  const filename = sanitizeAttachmentFilename('../../evil"\r\nX-Evil: yes.html');
  assert.equal(filename, 'evil___X-Evil: yes.html');
  assert.doesNotMatch(filename, /[\r\n"\\/]/);
});

test('shared blob metadata never stores a logical uploader filename', () => {
  const policy = createAttachmentStoragePolicy({
    sanitizedImage: null,
    originalName: 'private-report.pdf',
  });
  const metadata = createAttachmentBlobMetadata(policy);

  assert.equal(metadata['X-Amz-Meta-Original-Filename'], undefined);
  assert.equal(
    metadata['Content-Disposition'],
    'attachment; filename="attachment.bin"',
  );
});

test('delivery uses the logical filename instead of shared blob metadata', () => {
  const sharedBlobStat = {
    metaData: {
      'content-type': 'image/jpeg',
      'content-disposition': 'inline; filename="attachment.bin"',
      'x-amz-meta-void-sanitized-image': '1',
    },
  };

  const protectedHeaders = createProtectedAttachmentResponseHeaders(
    sharedBlobStat,
    'blobs/v1/sha256/aa/hash',
    'my-cat.jpg',
  );
  const signedParams = createPresignedAttachmentResponseParams(
    sharedBlobStat,
    'blobs/v1/sha256/aa/hash',
    'my-cat.jpg',
  );

  assert.equal(
    protectedHeaders['Content-Disposition'],
    'inline; filename="my-cat.jpg"',
  );
  assert.equal(
    signedParams['response-content-disposition'],
    'inline; filename="my-cat.jpg"',
  );
});

test('signed-original generation is not given client-controlled descriptor metadata', async () => {
  const attachmentId = '11111111-1111-4111-8111-111111111111';
  let receivedArguments;
  const attachDelivery = createAttachmentDeliveryMapper({
    async queryAttachmentObjects() {
      return [{
        id: attachmentId,
        object_key: `conversation/${attachmentId}.bin`,
        filename: 'stored-name.bin',
      }];
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

  assert.deepEqual(receivedArguments, [
    `conversation/${attachmentId}.bin`,
    {
      id: attachmentId,
      object_key: `conversation/${attachmentId}.bin`,
      filename: 'stored-name.bin',
    },
  ]);
});

test('unmarked attachments are not given VMD inline delivery URLs', async () => {
  const attachmentId = '22222222-2222-4222-8222-222222222222';
  let imageDeliveryCalls = 0;
  const attachDelivery = createAttachmentDeliveryMapper({
    async queryAttachmentObjects() {
      return [{ id: attachmentId, object_key: `conversation/${attachmentId}.bin` }];
    },
    async createOriginalDelivery() {
      return {
        url: 'https://cdn.invalid/signed',
        url_expires_at: Date.now() + 60_000,
        inline: false,
      };
    },
    async createImageDelivery() {
      imageDeliveryCalls += 1;
      return { display_url: 'https://vmd.invalid/image' };
    },
  });

  const [message] = await attachDelivery([{
    attachments: [JSON.stringify({
      url: `/api/conversations/123/attachments/${attachmentId}`,
      mime: 'image/jpeg',
      name: 'legacy.jpg',
    })],
  }], 'conversation-id');
  const [attachment] = message.attachments.map((entry) => JSON.parse(entry));

  assert.equal(imageDeliveryCalls, 0);
  assert.equal(attachment.inline, false);
  assert.equal(attachment.display_url, undefined);
});

test('properly marked attachments preserve VMD inline delivery URLs', async () => {
  const attachmentId = '33333333-3333-4333-8333-333333333333';
  let imageDeliveryCalls = 0;
  const attachDelivery = createAttachmentDeliveryMapper({
    async queryAttachmentObjects() {
      return [{ id: attachmentId, object_key: `conversation/${attachmentId}.bin` }];
    },
    async createOriginalDelivery() {
      return {
        url: 'https://cdn.invalid/signed',
        url_expires_at: Date.now() + 60_000,
        inline: true,
      };
    },
    async createImageDelivery() {
      imageDeliveryCalls += 1;
      return {
        display_url: 'https://vmd.invalid/image',
        display_url_expires_at: Date.now() + 60_000,
        display_variants: {
          small: {
            url: 'https://vmd.invalid/image/small',
            expires_at: Date.now() + 60_000,
            width: 480,
          },
          medium: {
            url: 'https://vmd.invalid/image/medium',
            expires_at: Date.now() + 60_000,
            width: 960,
          },
        },
      };
    },
  });

  const [message] = await attachDelivery([{
    attachments: [JSON.stringify({
      url: `/api/conversations/123/attachments/${attachmentId}`,
      mime: 'image/jpeg',
      name: 'trusted.jpg',
    })],
  }], 'conversation-id');
  const [attachment] = message.attachments.map((entry) => JSON.parse(entry));

  assert.equal(imageDeliveryCalls, 1);
  assert.equal(attachment.inline, true);
  assert.equal(attachment.display_url, 'https://vmd.invalid/image');
  assert.equal(
    attachment.display_variants.small.url,
    'https://vmd.invalid/image/small',
  );
});

test('server-derived inline delivery metadata is never persisted from client input', () => {
  const attachmentId = '44444444-4444-4444-8444-444444444444';
  const [stored] = normalizeStoredAttachments([JSON.stringify({
    url: `/api/conversations/123/attachments/${attachmentId}`,
    mime: 'image/jpeg',
    inline: true,
    display_url: 'https://vmd.invalid/forged',
    display_variants: {
      medium: {
        url: 'https://vmd.invalid/forged-medium',
        expires_at: Date.now() + 60_000,
        width: 960,
      },
    },
  })]);
  const descriptor = JSON.parse(stored);

  assert.equal(descriptor.inline, undefined);
  assert.equal(descriptor.display_url, undefined);
  assert.equal(descriptor.display_variants, undefined);
});
