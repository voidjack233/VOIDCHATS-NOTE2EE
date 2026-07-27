import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachmentNeedsDeliveryRefresh,
  messagesNeedAttachmentDeliveryRefresh,
} from '../../../src/Services/Chat/attachmentDeliveryFreshness';
import type { Attachment } from '../../../src/Services/Chat/chatTypes';

const NOW = Date.parse('2026-07-27T03:00:00.000Z');
const ATTACHMENT_ID = '11111111-1111-4111-8111-111111111111';
const STABLE_URL = `/api/conversations/test/attachments/${ATTACHMENT_ID}`;

function createAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: ATTACHMENT_ID,
    fallback_url: STABLE_URL,
    url: STABLE_URL,
    mime: 'image/jpeg',
    name: 'photo.jpg',
    width: 640,
    height: 480,
    ...overrides,
  };
}

test('legacy cached image without a delivery decision requires rehydration', () => {
  assert.equal(attachmentNeedsDeliveryRefresh(createAttachment(), NOW), true);
});

test('explicit server inline denial is stable and does not create a refresh loop', () => {
  assert.equal(
    attachmentNeedsDeliveryRefresh(createAttachment({ inline: false }), NOW),
    false,
  );
});

test('fresh responsive VMD variant keeps cached delivery usable', () => {
  assert.equal(
    attachmentNeedsDeliveryRefresh(createAttachment({
      inline: true,
      display_variants: {
        small: {
          url: 'https://vmd.invalid/image/small',
          expires_at: NOW + 60_000,
          width: 480,
        },
      },
    }), NOW),
    false,
  );
});

test('thumb-only delivery cannot suppress timeline rehydration', () => {
  assert.equal(
    attachmentNeedsDeliveryRefresh(createAttachment({
      inline: true,
      display_variants: {
        thumb: {
          url: 'https://vmd.invalid/image/thumb',
          expires_at: NOW + 60_000,
          width: 160,
        },
      },
    }), NOW),
    true,
  );
});

test('expired VMD and original capabilities require one message-window refresh', () => {
  assert.equal(
    attachmentNeedsDeliveryRefresh(createAttachment({
      inline: true,
      url: 'https://cdn.invalid/image',
      url_expires_at: NOW - 1,
      display_url: 'https://vmd.invalid/image',
      display_url_expires_at: NOW - 1,
    }), NOW),
    true,
  );
});

test('fresh trusted signed original avoids refresh when VMD is unavailable', () => {
  assert.equal(
    attachmentNeedsDeliveryRefresh(createAttachment({
      inline: true,
      url: 'https://cdn.invalid/image',
      url_expires_at: NOW + 60_000,
    }), NOW),
    false,
  );
});

test('non-image and active-content descriptors never request image delivery', () => {
  assert.equal(
    attachmentNeedsDeliveryRefresh(createAttachment({
      mime: 'text/html',
      name: 'misleading.jpg',
    }), NOW),
    false,
  );
  assert.equal(
    attachmentNeedsDeliveryRefresh(createAttachment({
      mime: 'image/svg+xml',
      name: 'active.svg',
    }), NOW),
    false,
  );
});

test('message scan detects stale image delivery without inspecting message text', () => {
  assert.equal(
    messagesNeedAttachmentDeliveryRefresh([{
      attachments: [JSON.stringify(createAttachment())],
    }], NOW),
    true,
  );
  assert.equal(
    messagesNeedAttachmentDeliveryRefresh([{
      attachments: [JSON.stringify(createAttachment({ inline: false }))],
    }], NOW),
    false,
  );
});
