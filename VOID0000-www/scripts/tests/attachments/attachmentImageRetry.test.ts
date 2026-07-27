import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAttachmentRenderIdentity,
  resolveAttachmentRenderSources,
  resolveAttachmentViewerSources,
  type AttachmentRenderSource,
} from '../../../src/Services/Chat/attachmentRenderPolicy';
import type { Attachment } from '../../../src/Services/Chat/chatTypes';
import {
  createAttachmentImageAttemptState,
  recordAttachmentImageFailure,
  recordAttachmentImageSuccess,
  selectAttachmentImageSource,
} from '../../../src/components/Chat/Attachments/attachmentImageRetry';

const DISPLAY_1: AttachmentRenderSource = {
  kind: 'display',
  url: 'https://vmd.void.invalid/image?generation=1',
};
const DISPLAY_2: AttachmentRenderSource = {
  kind: 'display',
  url: 'https://vmd.void.invalid/image?generation=2',
};
const DISPLAY_3: AttachmentRenderSource = {
  kind: 'display',
  url: 'https://vmd.void.invalid/image?generation=3',
};
const ORIGINAL_1: AttachmentRenderSource = {
  kind: 'original',
  url: 'https://cdn.void.invalid/image?generation=1',
};
const IDENTITY = 'id:11111111-1111-4111-8111-111111111111';
const resolveSources = (attachment: Attachment) => resolveAttachmentRenderSources(
  attachment,
  {
    isUrlUsable: (url, expiresAt) => (
      /^https?:\/\//.test(url) &&
      (expiresAt === undefined || expiresAt > Date.now() + 5_000)
    ),
  },
);

test('successful VMD source remains selected without a retry', () => {
  const initial = createAttachmentImageAttemptState(IDENTITY);
  const selected = selectAttachmentImageSource(initial, IDENTITY, [DISPLAY_1]);
  assert.deepEqual(selected, DISPLAY_1);

  const loaded = recordAttachmentImageSuccess(initial, IDENTITY, DISPLAY_1);
  assert.deepEqual(loaded.failures, []);
  assert.deepEqual(
    selectAttachmentImageSource(loaded, IDENTITY, [DISPLAY_1]),
    DISPLAY_1,
  );
});

test('failed VMD source retries one genuinely changed URL and then stops', () => {
  const initial = createAttachmentImageAttemptState(IDENTITY);
  const firstFailure = recordAttachmentImageFailure(initial, IDENTITY, DISPLAY_1);

  assert.equal(
    selectAttachmentImageSource(firstFailure, IDENTITY, [DISPLAY_1]),
    null,
  );
  assert.deepEqual(
    selectAttachmentImageSource(firstFailure, IDENTITY, [DISPLAY_2]),
    DISPLAY_2,
  );

  const retryFailure = recordAttachmentImageFailure(
    firstFailure,
    IDENTITY,
    DISPLAY_2,
  );
  assert.equal(
    selectAttachmentImageSource(retryFailure, IDENTITY, [DISPLAY_3]),
    null,
  );
});

test('rerendering the same failed URL cannot create a retry loop', () => {
  const initial = createAttachmentImageAttemptState(IDENTITY);
  const failed = recordAttachmentImageFailure(initial, IDENTITY, DISPLAY_1);
  const repeated = recordAttachmentImageFailure(failed, IDENTITY, DISPLAY_1);

  assert.strictEqual(repeated, failed);
  assert.equal(
    selectAttachmentImageSource(repeated, IDENTITY, [DISPLAY_1]),
    null,
  );
});

test('same attachment identity accepts a refreshed URL without remounting', () => {
  const failed = recordAttachmentImageFailure(
    createAttachmentImageAttemptState(IDENTITY),
    IDENTITY,
    DISPLAY_1,
  );

  assert.deepEqual(
    selectAttachmentImageSource(failed, IDENTITY, [DISPLAY_2]),
    DISPLAY_2,
  );
});

test('failed VMD falls back once to an explicitly trusted inline original', () => {
  const failed = recordAttachmentImageFailure(
    createAttachmentImageAttemptState(IDENTITY),
    IDENTITY,
    DISPLAY_1,
  );

  assert.deepEqual(
    selectAttachmentImageSource(
      failed,
      IDENTITY,
      [DISPLAY_1, ORIGINAL_1],
    ),
    ORIGINAL_1,
  );
});

test('octet-stream or non-inline original is never offered to img', () => {
  const common: Attachment = {
    id: '11111111-1111-4111-8111-111111111111',
    url: ORIGINAL_1.url,
    mime: 'image/jpeg',
    url_expires_at: Date.now() + 60_000,
  };

  for (const inline of [false, undefined, null, 0, 'true']) {
    const attachment = {
      ...common,
      inline,
    } as Attachment;
    assert.deepEqual(resolveSources(attachment), []);
  }
});

test('both failed sources produce a stable unavailable state', () => {
  let state = createAttachmentImageAttemptState(IDENTITY);
  state = recordAttachmentImageFailure(state, IDENTITY, DISPLAY_1);
  state = recordAttachmentImageFailure(state, IDENTITY, ORIGINAL_1);

  assert.equal(
    selectAttachmentImageSource(
      state,
      IDENTITY,
      [DISPLAY_1, ORIGINAL_1],
    ),
    null,
  );
});

test('failure state cannot leak into a virtualized row reused for another attachment', () => {
  const failed = recordAttachmentImageFailure(
    createAttachmentImageAttemptState(IDENTITY),
    IDENTITY,
    DISPLAY_1,
  );
  const nextIdentity = 'id:22222222-2222-4222-8222-222222222222';

  assert.deepEqual(
    selectAttachmentImageSource(failed, nextIdentity, [DISPLAY_1]),
    DISPLAY_1,
  );
});

test('trusted delivery exposes VMD first and direct original second', () => {
  const attachment: Attachment = {
    id: '11111111-1111-4111-8111-111111111111',
    fallback_url: '/api/conversations/test/attachments/11111111-1111-4111-8111-111111111111',
    display_url: DISPLAY_1.url,
    display_url_expires_at: Date.now() + 60_000,
    url: ORIGINAL_1.url,
    url_expires_at: Date.now() + 60_000,
    inline: true,
  };

  assert.deepEqual(resolveSources(attachment), [
    DISPLAY_1,
    ORIGINAL_1,
  ]);
  assert.equal(
    getAttachmentRenderIdentity(attachment),
    'id:11111111-1111-4111-8111-111111111111',
  );
});

test('responsive delivery gives timeline and viewer distinct native srcsets', () => {
  const expiresAt = Date.now() + 60_000;
  const attachment: Attachment = {
    id: '11111111-1111-4111-8111-111111111111',
    fallback_url: '/api/conversations/test/attachments/11111111-1111-4111-8111-111111111111',
    display_url: 'https://vmd.invalid/medium',
    display_url_expires_at: expiresAt,
    display_variants: {
      thumb: { url: 'https://vmd.invalid/thumb', expires_at: expiresAt, width: 160 },
      small: { url: 'https://vmd.invalid/small', expires_at: expiresAt, width: 480 },
      medium: { url: 'https://vmd.invalid/medium', expires_at: expiresAt, width: 960 },
      large: { url: 'https://vmd.invalid/large', expires_at: expiresAt, width: 1600 },
    },
    url: ORIGINAL_1.url,
    url_expires_at: expiresAt,
    inline: true,
  };
  const timeline = resolveSources(attachment);
  const viewer = resolveAttachmentViewerSources(attachment, {
    isUrlUsable: (url, expiry) => (
      /^https?:\/\//.test(url) &&
      (expiry === undefined || expiry > Date.now() + 5_000)
    ),
  });

  assert.equal(timeline[0]?.url, 'https://vmd.invalid/small');
  assert.equal(
    timeline[0]?.srcSet,
    'https://vmd.invalid/small 480w, https://vmd.invalid/medium 960w',
  );
  assert.equal(viewer[0]?.url, 'https://vmd.invalid/medium');
  assert.equal(
    viewer[0]?.srcSet,
    'https://vmd.invalid/medium 960w, https://vmd.invalid/large 1600w',
  );
  assert.equal(viewer[1]?.url, ORIGINAL_1.url);
});
