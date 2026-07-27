import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAttachmentDeliveryMapper,
  DEFAULT_ATTACHMENT_DELIVERY_MAX_CONCURRENCY,
  MAX_ATTACHMENT_DELIVERY_MAX_CONCURRENCY,
  resolveAttachmentDeliveryMaxConcurrency,
} from '../../../server/utils/attachmentDeliveryCore.js';

function createAttachmentId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function createImageAttachment(attachmentId, index, overrides = {}) {
  return JSON.stringify({
    url: `/api/conversations/test/attachments/${attachmentId}`,
    mime: 'image/jpeg',
    name: `image-${index}.jpg`,
    width: 640,
    height: 480,
    position: index,
    ...overrides,
  });
}

function createMessages(attachmentCount) {
  return [{
    attachments: Array.from({ length: attachmentCount }, (_, index) => (
      createImageAttachment(createAttachmentId(index + 1), index)
    )),
  }];
}

function queryRequestedAttachmentObjects(_conversationId, attachmentIds) {
  return attachmentIds.map((id) => ({
    id,
    object_key: `conversation/${id}.bin`,
  }));
}

function parseDeliveredAttachments(messages) {
  return messages[0].attachments.map((attachment) => JSON.parse(attachment));
}

test('attachment delivery never exceeds configured concurrency and preserves order', async () => {
  const configuredConcurrency = 3;
  let activeDeliveries = 0;
  let maximumActiveDeliveries = 0;
  const messages = createMessages(24);
  const attachDelivery = createAttachmentDeliveryMapper({
    queryAttachmentObjects: queryRequestedAttachmentObjects,
    maxConcurrency: configuredConcurrency,
    async createOriginalDelivery(objectKey) {
      activeDeliveries += 1;
      maximumActiveDeliveries = Math.max(
        maximumActiveDeliveries,
        activeDeliveries,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeDeliveries -= 1;
      return {
        url: `https://cdn.invalid/${objectKey}`,
        url_expires_at: Date.now() + 60_000,
        inline: true,
      };
    },
  });

  const delivered = parseDeliveredAttachments(
    await attachDelivery(messages, 'conversation-id'),
  );

  assert.equal(maximumActiveDeliveries, configuredConcurrency);
  assert.deepEqual(
    delivered.map((attachment) => attachment.position),
    Array.from({ length: 24 }, (_, index) => index),
  );
  assert.deepEqual(
    delivered.map((attachment) => attachment.id),
    Array.from({ length: 24 }, (_, index) => createAttachmentId(index + 1)),
  );
});

test('a large attachment set completes through the bounded delivery pool', async () => {
  const attachmentCount = 128;
  let completedDeliveries = 0;
  const attachDelivery = createAttachmentDeliveryMapper({
    queryAttachmentObjects: queryRequestedAttachmentObjects,
    maxConcurrency: 8,
    async createOriginalDelivery(objectKey) {
      await new Promise((resolve) => setImmediate(resolve));
      completedDeliveries += 1;
      return {
        url: `https://cdn.invalid/${objectKey}`,
        url_expires_at: Date.now() + 60_000,
        inline: true,
      };
    },
  });

  const delivered = parseDeliveredAttachments(
    await attachDelivery(createMessages(attachmentCount), 'conversation-id'),
  );

  assert.equal(completedDeliveries, attachmentCount);
  assert.equal(delivered.length, attachmentCount);
  assert.equal(delivered[0].position, 0);
  assert.equal(delivered.at(-1).position, attachmentCount - 1);
});

test('invalid delivery concurrency values use the safe default', async () => {
  for (const invalidValue of [
    undefined,
    null,
    '',
    '0',
    '-1',
    '1.5',
    'not-a-number',
    '33',
    0,
    -1,
    1.5,
    MAX_ATTACHMENT_DELIVERY_MAX_CONCURRENCY + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      resolveAttachmentDeliveryMaxConcurrency(invalidValue),
      DEFAULT_ATTACHMENT_DELIVERY_MAX_CONCURRENCY,
    );
  }

  assert.equal(resolveAttachmentDeliveryMaxConcurrency('1'), 1);
  assert.equal(resolveAttachmentDeliveryMaxConcurrency('8'), 8);
  assert.equal(
    resolveAttachmentDeliveryMaxConcurrency('32'),
    MAX_ATTACHMENT_DELIVERY_MAX_CONCURRENCY,
  );

  let activeDeliveries = 0;
  let maximumActiveDeliveries = 0;
  const attachDelivery = createAttachmentDeliveryMapper({
    queryAttachmentObjects: queryRequestedAttachmentObjects,
    maxConcurrency: 'invalid',
    async createOriginalDelivery(objectKey) {
      activeDeliveries += 1;
      maximumActiveDeliveries = Math.max(
        maximumActiveDeliveries,
        activeDeliveries,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeDeliveries -= 1;
      return {
        url: `https://cdn.invalid/${objectKey}`,
        url_expires_at: Date.now() + 60_000,
        inline: true,
      };
    },
  });

  await attachDelivery(createMessages(12), 'conversation-id');
  assert.equal(
    maximumActiveDeliveries,
    DEFAULT_ATTACHMENT_DELIVERY_MAX_CONCURRENCY,
  );
});

test('an original delivery failure preserves protected attachment URLs', async () => {
  const messages = createMessages(6);
  const warnings = [];
  const attachDelivery = createAttachmentDeliveryMapper({
    queryAttachmentObjects: queryRequestedAttachmentObjects,
    maxConcurrency: 3,
    logger: {
      warn(...args) {
        warnings.push(args);
      },
    },
    async createOriginalDelivery(objectKey) {
      if (objectKey.includes(createAttachmentId(2))) {
        throw new Error('signing failed');
      }
      return {
        url: `https://cdn.invalid/${objectKey}`,
        url_expires_at: Date.now() + 60_000,
        inline: true,
      };
    },
  });

  const delivered = parseDeliveredAttachments(
    await attachDelivery(messages, 'conversation-id'),
  );

  assert.equal(warnings.length, 1);
  assert.deepEqual(
    delivered.map((attachment) => attachment.url),
    Array.from({ length: 6 }, (_, index) => (
      `/api/conversations/test/attachments/${createAttachmentId(index + 1)}`
    )),
  );
  assert.ok(delivered.every((attachment) => !('fallback_url' in attachment)));
});

test('VMD generation requires original delivery inline to be exactly true', async (t) => {
  const cases = [
    { name: 'true permits VMD', value: true, expectedCalls: 1 },
    { name: 'false blocks VMD', value: false, expectedCalls: 0 },
    { name: 'omitted blocks VMD', omit: true, expectedCalls: 0 },
    { name: 'null blocks VMD', value: null, expectedCalls: 0 },
    { name: 'zero blocks VMD', value: 0, expectedCalls: 0 },
    { name: 'empty string blocks VMD', value: '', expectedCalls: 0 },
    { name: 'truthy non-boolean blocks VMD', value: 'true', expectedCalls: 0 },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const attachmentId = createAttachmentId(1);
      let imageDeliveryCalls = 0;
      const attachDelivery = createAttachmentDeliveryMapper({
        queryAttachmentObjects: queryRequestedAttachmentObjects,
        async createOriginalDelivery(objectKey) {
          const delivery = {
            url: `https://cdn.invalid/${objectKey}`,
            url_expires_at: Date.now() + 60_000,
          };
          if (!testCase.omit) delivery.inline = testCase.value;
          return delivery;
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
            },
          };
        },
      });

      const [attachment] = parseDeliveredAttachments(
        await attachDelivery([{
          attachments: [createImageAttachment(attachmentId, 0, {
            mime: 'image/png',
            name: 'trusted-looking.png',
            width: 1920,
            height: 1080,
          })],
        }], 'conversation-id'),
      );

      assert.equal(imageDeliveryCalls, testCase.expectedCalls);
      assert.equal(
        Object.hasOwn(attachment, 'display_url'),
        testCase.expectedCalls === 1,
      );
      assert.equal(
        Object.hasOwn(attachment, 'display_variants'),
        testCase.expectedCalls === 1,
      );
    });
  }
});
