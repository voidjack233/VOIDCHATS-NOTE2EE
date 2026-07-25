import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  ChatImageSanitizationError,
  MAX_CHAT_ATTACHMENT_BYTES,
  sanitizeChatAttachmentImage,
} from '../../../server/utils/chatImageSanitizer.js';
import { transformVmdImage } from '../../../server/vmd/imageVariants.js';

const ANIMATED_GIF = Buffer.from(
  'R0lGODlhAgACAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACH/C0ltYWdlTWFnaWNrDmdhbW1hPTAuNDU0NTQ1ACwAAAAAAgACAAACAoRRACH5BAAUAAAAIf8LSW1hZ2VNYWdpY2sOZ2FtbWE9MC40NTQ1NDUALAAAAAACAAIAgAAA/wAAAAIChFEAOw==',
  'base64',
);

function assertMetadataStripped(metadata) {
  assert.ok(metadata.orientation === undefined || metadata.orientation === 1);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  assert.equal(metadata.iptc, undefined);
  assert.equal(metadata.xmp, undefined);
  assert.equal(metadata.hasProfile, false);
  assert.equal(metadata.comments, undefined);
}

async function createTestImage(format) {
  const pipeline = sharp({
    create: {
      width: 24,
      height: 16,
      channels: 4,
      background: { r: 30, g: 120, b: 220, alpha: 0.8 },
    },
  });

  if (format === 'jpeg') return pipeline.jpeg({ quality: 90 }).toBuffer();
  if (format === 'png') return pipeline.png().toBuffer();
  if (format === 'webp') return pipeline.webp({ quality: 90 }).toBuffer();
  if (format === 'tiff') return pipeline.tiff({ compression: 'lzw' }).toBuffer();
  if (format === 'avif') return pipeline.avif({ quality: 80 }).toBuffer();
  throw new Error(`Unsupported test format: ${format}`);
}

test('sanitizes JPEG EXIF and applies orientation before stripping metadata', async () => {
  const source = await sharp({
    create: {
      width: 20,
      height: 30,
      channels: 3,
      background: { r: 230, g: 40, b: 20 },
    },
  })
    .jpeg({ quality: 100 })
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Copyright: 'VOID metadata test' },
    })
    .toBuffer();
  const sourceMetadata = await sharp(source).metadata();
  assert.equal(sourceMetadata.orientation, 6);
  assert.ok(sourceMetadata.exif);

  const result = await sanitizeChatAttachmentImage(source, 'image/jpeg');
  assert.ok(result);
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.width, 30);
  assert.equal(result.height, 20);

  const storedMetadata = await sharp(result.buffer).metadata();
  assert.equal(storedMetadata.width, 30);
  assert.equal(storedMetadata.height, 20);
  assertMetadataStripped(storedMetadata);
});

test('removes GPS-style EXIF metadata from stored images', async () => {
  const source = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: 10, g: 180, b: 90 },
    },
  })
    .jpeg({ quality: 95 })
    .withExif({
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '14/1 35/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '120/1 59/1 0/1',
      },
    })
    .toBuffer();
  assert.ok((await sharp(source).metadata()).exif);

  const result = await sanitizeChatAttachmentImage(source, 'image/jpeg');
  assert.ok(result);
  assertMetadataStripped(await sharp(result.buffer).metadata());
});

test('preserves supported static formats while sanitizing', async (context) => {
  const cases = [
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
    ['tiff', 'image/tiff'],
    ['avif', 'image/avif'],
  ];

  for (const [format, contentType] of cases) {
    await context.test(format, async () => {
      const source = await createTestImage(format);
      const result = await sanitizeChatAttachmentImage(source, contentType);
      assert.ok(result);
      assert.equal(result.sourceFormat, format);
      assert.equal(result.contentType, contentType);
      assert.equal(result.width, 24);
      assert.equal(result.height, 16);
      assertMetadataStripped(await sharp(result.buffer).metadata());
    });
  }
});

test('uses actual image bytes instead of trusting the claimed MIME', async () => {
  const source = await createTestImage('jpeg');
  const result = await sanitizeChatAttachmentImage(source, 'application/octet-stream');
  assert.ok(result);
  assert.equal(result.sourceFormat, 'jpeg');
  assert.equal(result.contentType, 'image/jpeg');
});

test('preserves all frames of animated GIF and WebP images', async (context) => {
  const animatedWebp = await sharp(ANIMATED_GIF, { animated: true })
    .webp({ loop: 0, delay: [100, 200] })
    .toBuffer();
  const cases = [
    ['gif', 'image/gif', ANIMATED_GIF],
    ['webp', 'image/webp', animatedWebp],
  ];

  for (const [format, contentType, source] of cases) {
    await context.test(format, async () => {
      const sourceMetadata = await sharp(source, { animated: true }).metadata();
      assert.equal(sourceMetadata.pages, 2);

      const result = await sanitizeChatAttachmentImage(source, contentType);
      assert.ok(result);
      assert.equal(result.animated, true);
      assert.equal(result.pages, 2);
      assert.equal(result.contentType, contentType);

      const storedMetadata = await sharp(result.buffer, { animated: true }).metadata();
      assert.equal(storedMetadata.pages, 2);
      assertMetadataStripped(storedMetadata);
    });
  }
});

test('rejects corrupt actual or claimed images without returning raw bytes', async () => {
  const corruptJpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);

  await assert.rejects(
    sanitizeChatAttachmentImage(corruptJpeg, 'application/octet-stream'),
    (error) => (
      error instanceof ChatImageSanitizationError &&
      error.code === 'ATTACHMENT_IMAGE_INVALID'
    ),
  );
  await assert.rejects(
    sanitizeChatAttachmentImage(Buffer.from('not an image'), 'image/png'),
    (error) => (
      error instanceof ChatImageSanitizationError &&
      error.code === 'ATTACHMENT_IMAGE_INVALID'
    ),
  );
  await assert.rejects(
    sanitizeChatAttachmentImage(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>private</text></svg>'),
      'application/octet-stream',
    ),
    (error) => (
      error instanceof ChatImageSanitizationError &&
      error.code === 'ATTACHMENT_IMAGE_UNSUPPORTED'
    ),
  );
});

test('leaves ordinary non-image attachment bytes on the existing path', async () => {
  const cases = [
    [Buffer.from('ordinary text attachment'), 'text/plain'],
    [Buffer.from('<?xml version="1.0"?><document />'), 'application/xml'],
    [Buffer.from([0x1f, 0x8b, 0x08, 0x00]), 'application/gzip'],
  ];

  for (const [source, contentType] of cases) {
    const result = await sanitizeChatAttachmentImage(source, contentType);
    assert.equal(result, null);
  }
});

test('rejects attachment byte and decoded-pixel safety limit violations', async () => {
  await assert.rejects(
    sanitizeChatAttachmentImage(
      Buffer.alloc(MAX_CHAT_ATTACHMENT_BYTES + 1),
      'application/octet-stream',
    ),
    (error) => (
      error instanceof ChatImageSanitizationError &&
      error.code === 'ATTACHMENT_TOO_LARGE'
    ),
  );

  const tooManyPixels = await sharp({
    create: {
      width: 5001,
      height: 5000,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
    limitInputPixels: false,
  }).png().toBuffer();
  await assert.rejects(
    sanitizeChatAttachmentImage(tooManyPixels, 'image/png'),
    (error) => (
      error instanceof ChatImageSanitizationError &&
      error.code === 'ATTACHMENT_IMAGE_LIMIT_EXCEEDED'
    ),
  );
});

test('VMD can transform a sanitized stored image normally', async () => {
  const source = await createTestImage('png');
  const sanitized = await sanitizeChatAttachmentImage(source, 'image/png');
  assert.ok(sanitized);

  const variant = await transformVmdImage(sanitized.buffer, 'small');
  assert.equal(variant.contentType, 'image/webp');
  assert.equal(variant.width, 24);
  assert.equal(variant.height, 16);
  assert.ok(variant.body.length > 0);
});
