import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareAttachmentFile } from '../../../src/Services/Chat/attachmentService';
import {
  AttachmentPreparationError,
  getAttachmentUploadErrorLabel,
  getStaticImageNormalizationPlan,
  isUnconvertedHeicHeif,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_STATIC_IMAGE_PIXELS,
  NORMALIZED_STATIC_IMAGE_MAX_EDGE,
  NORMALIZED_STATIC_IMAGE_TARGET_PIXELS,
  resolveSupportedAttachmentImageMime,
} from '../../../src/Services/Chat/attachmentUploadPolicy';

interface BrowserImageMockOptions {
  width: number;
  height: number;
  failDecode?: boolean;
  encodedSize?: number;
}

function installBrowserImageMocks(options: BrowserImageMockOptions) {
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let encodeCount = 0;

  class MockImage {
    naturalWidth = options.width;
    naturalHeight = options.height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(_value: string) {
      queueMicrotask(() => {
        if (options.failDecode) this.onerror?.();
        else this.onload?.();
      });
    }
  }

  class MockCanvas {
    width = 0;
    height = 0;

    getContext() {
      return {
        drawImage() {},
        getImageData: () => ({
          data: new Uint8ClampedArray(this.width * this.height * 4),
        }),
      };
    }

    toBlob(callback: (blob: Blob | null) => void, type?: string) {
      encodeCount += 1;
      callback(new Blob([
        options.encodedSize
          ? new Uint8Array(options.encodedSize)
          : 'normalized-image',
      ], { type: type || 'image/png' }));
    }
  }

  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: MockImage,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(name: string) {
        assert.equal(name, 'canvas');
        return new MockCanvas();
      },
    },
  });

  return {
    getEncodeCount: () => encodeCount,
    restore() {
      if (originalImage) Object.defineProperty(globalThis, 'Image', originalImage);
      else delete (globalThis as { Image?: unknown }).Image;
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else delete (globalThis as { document?: unknown }).document;
    },
  };
}

function animatedWebPBytes(): Uint8Array {
  const bytes = new Uint8Array(20);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(bytes.buffer).setUint32(4, 12, true);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('ANIM'), 12);
  new DataView(bytes.buffer).setUint32(16, 0, true);
  return bytes;
}

function heicBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setUint32(0, 16);
  bytes.set(new TextEncoder().encode('ftyp'), 4);
  bytes.set(new TextEncoder().encode('heic'), 8);
  return bytes;
}

test('known attachment server errors retain useful user-visible labels', () => {
  const cases = [
    ['ATTACHMENT_IMAGE_LIMIT_EXCEEDED', 'Image resolution is too large'],
    ['ATTACHMENT_IMAGE_UNSUPPORTED', 'Image format is not supported'],
    ['ATTACHMENT_IMAGE_INVALID', 'Image is invalid or corrupted'],
    ['ATTACHMENT_IMAGE_SANITIZATION_FAILED', 'Image could not be processed safely'],
    ['ATTACHMENT_TOO_LARGE', 'Attachment exceeds the 10 MiB limit'],
    ['ATTACHMENT_METADATA_INVALID', 'Attachment metadata is invalid'],
  ] as const;

  for (const [code, expected] of cases) {
    assert.equal(getAttachmentUploadErrorLabel({ code, status: 400 }), expected);
  }
  assert.equal(
    getAttachmentUploadErrorLabel({ code: 'ATTACHMENT_IMAGE_UNSUPPORTED', status: 415 }),
    'Image format is not supported',
  );
  assert.equal(
    getAttachmentUploadErrorLabel({ code: 'ATTACHMENT_IMAGE_LIMIT_EXCEEDED', status: 413 }),
    'Image resolution is too large',
  );
});

test('existing rate, quota, timeout, network, and service labels remain specific', () => {
  assert.equal(
    getAttachmentUploadErrorLabel({ code: 'ATTACHMENT_STAGED_QUOTA_EXCEEDED' }),
    'Too many unsent attachments',
  );
  assert.equal(getAttachmentUploadErrorLabel({ status: 429 }), 'Upload limit reached');
  assert.equal(getAttachmentUploadErrorLabel({ code: 'REQUEST_TIMEOUT' }), 'Upload timed out');
  assert.equal(getAttachmentUploadErrorLabel({ message: 'Failed to fetch' }), 'Waiting for network');
  assert.equal(getAttachmentUploadErrorLabel({ status: 503 }), 'Service unavailable');
});

test('high-resolution static images receive a bounded aspect-ratio-preserving plan', () => {
  const plan = getStaticImageNormalizationPlan(8_000, 6_000);

  assert.deepEqual(plan, {
    required: true,
    width: 4_000,
    height: 3_000,
  });
  assert.ok(plan.width * plan.height <= NORMALIZED_STATIC_IMAGE_TARGET_PIXELS);
  assert.ok(plan.width <= NORMALIZED_STATIC_IMAGE_MAX_EDGE);
  assert.ok(plan.height <= NORMALIZED_STATIC_IMAGE_MAX_EDGE);
  assert.equal(plan.width / plan.height, 4 / 3);
});

test('extreme aspect ratios stay bounded without being stretched', () => {
  const width = 12_000;
  const height = 3_000;
  const plan = getStaticImageNormalizationPlan(width, height);

  assert.equal(plan.required, true);
  assert.equal(plan.width, NORMALIZED_STATIC_IMAGE_MAX_EDGE);
  assert.ok(plan.width < width);
  assert.ok(plan.height < height);
  assert.ok(Math.abs((plan.width / plan.height) - (width / height)) < 0.01);
});

test('images within the server pixel limit remain unchanged and are never upscaled', () => {
  const width = 4_000;
  const height = 3_000;
  const plan = getStaticImageNormalizationPlan(width, height);

  assert.equal(width * height < MAX_STATIC_IMAGE_PIXELS, true);
  assert.deepEqual(plan, { required: false, width, height });
  assert.deepEqual(
    getStaticImageNormalizationPlan(5_000, 5_000),
    { required: false, width: 5_000, height: 5_000 },
  );
});

test('unconverted HEIC/HEIF is rejected but a browser-converted JPEG is accepted', () => {
  assert.equal(isUnconvertedHeicHeif({ name: 'IMG_0001.HEIC', type: 'image/heic' }), true);
  assert.equal(isUnconvertedHeicHeif({ name: 'IMG_0001.heif', type: '' }), true);
  assert.equal(isUnconvertedHeicHeif({ name: 'IMG_0001.heic', type: 'image/jpeg' }), false);
  assert.equal(
    getAttachmentUploadErrorLabel({ code: 'ATTACHMENT_HEIC_UNSUPPORTED', status: 415 }),
    'HEIC/HEIF images are not supported here. Choose the photo through Media or convert it to JPEG/PNG.',
  );
});

test('supported image MIME resolution keeps JPEG first-class and infers safe extensions', () => {
  assert.equal(resolveSupportedAttachmentImageMime({ name: 'photo.jpg', type: 'image/jpeg' }), 'image/jpeg');
  assert.equal(resolveSupportedAttachmentImageMime({ name: 'photo.webp', type: '' }), 'image/webp');
  assert.equal(resolveSupportedAttachmentImageMime({ name: 'photo.heic', type: 'image/heic' }), null);
});

test('high-resolution static JPEG is normalized before upload metadata is built', async () => {
  const browser = installBrowserImageMocks({ width: 8_000, height: 6_000 });
  try {
    const source = new File(['source-jpeg'], 'camera.jpeg', { type: 'image/jpeg' });
    const prepared = await prepareAttachmentFile(source);

    assert.notStrictEqual(prepared.file, source);
    assert.equal(prepared.file.type, 'image/jpeg');
    assert.equal(prepared.file.name, 'camera.jpeg');
    assert.equal(prepared.attachment.mime, 'image/jpeg');
    assert.equal(prepared.attachment.width, 4_000);
    assert.equal(prepared.attachment.height, 3_000);
    assert.equal(prepared.attachment.size, prepared.file.size);
    assert.equal(browser.getEncodeCount(), 1);
  } finally {
    browser.restore();
  }
});

test('ordinary images remain the original File and are not re-encoded', async () => {
  const browser = installBrowserImageMocks({ width: 4_000, height: 3_000 });
  try {
    const source = new File(['source-jpeg'], 'camera.jpg', { type: 'image/jpeg' });
    const prepared = await prepareAttachmentFile(source);

    assert.strictEqual(prepared.file, source);
    assert.equal(prepared.attachment.width, 4_000);
    assert.equal(prepared.attachment.height, 3_000);
    assert.equal(browser.getEncodeCount(), 0);
  } finally {
    browser.restore();
  }
});

test('oversized animated WebP and GIF images are never flattened through canvas', async () => {
  const browser = installBrowserImageMocks({ width: 8_000, height: 6_000 });
  try {
    const animatedWebP = new File([animatedWebPBytes()], 'animated.webp', { type: 'image/webp' });
    const animatedGif = new File(['GIF89a'], 'animated.gif', { type: 'image/gif' });

    await assert.rejects(
      prepareAttachmentFile(animatedWebP),
      (error: unknown) => error instanceof AttachmentPreparationError &&
        error.code === 'ATTACHMENT_IMAGE_LIMIT_EXCEEDED',
    );
    await assert.rejects(
      prepareAttachmentFile(animatedGif),
      (error: unknown) => error instanceof AttachmentPreparationError &&
        error.code === 'ATTACHMENT_IMAGE_LIMIT_EXCEEDED',
    );
    assert.equal(browser.getEncodeCount(), 0);
  } finally {
    browser.restore();
  }
});

test('unconverted HEIC and over-limit files fail before browser decoding', async () => {
  const heic = new File(['heic'], 'camera.heic', { type: 'image/heic' });
  const disguisedHeic = new File([heicBytes()], 'camera.jpg', { type: 'image/jpeg' });
  const oversized = new File(
    [new Uint8Array(MAX_ATTACHMENT_FILE_BYTES + 1)],
    'oversized.bin',
    { type: 'application/octet-stream' },
  );

  await assert.rejects(
    prepareAttachmentFile(heic),
    (error: unknown) => error instanceof AttachmentPreparationError &&
      error.code === 'ATTACHMENT_HEIC_UNSUPPORTED',
  );
  await assert.rejects(
    prepareAttachmentFile(disguisedHeic),
    (error: unknown) => error instanceof AttachmentPreparationError &&
      error.code === 'ATTACHMENT_HEIC_UNSUPPORTED',
  );
  await assert.rejects(
    prepareAttachmentFile(oversized),
    (error: unknown) => error instanceof AttachmentPreparationError &&
      error.code === 'ATTACHMENT_TOO_LARGE',
  );
});

test('normalized output remains subject to the 10 MiB attachment limit', async () => {
  const browser = installBrowserImageMocks({
    width: 8_000,
    height: 6_000,
    encodedSize: MAX_ATTACHMENT_FILE_BYTES + 1,
  });
  try {
    const source = new File(['compressed-source'], 'camera.jpg', { type: 'image/jpeg' });
    await assert.rejects(
      prepareAttachmentFile(source),
      (error: unknown) => error instanceof AttachmentPreparationError &&
        error.code === 'ATTACHMENT_TOO_LARGE',
    );
    assert.equal(browser.getEncodeCount(), 3);
  } finally {
    browser.restore();
  }
});
