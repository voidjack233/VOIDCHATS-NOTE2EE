import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  MessageEditAttachmentError,
  preserveMessageEditAttachments,
} from '../../../server/attachments/editPolicy.js';

const EXISTING_ID = '11111111-1111-4111-8111-111111111111';
const STAGED_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_ID = '33333333-3333-4333-8333-333333333333';
const EXPIRED_ID = '44444444-4444-4444-8444-444444444444';

function protectedUrl(attachmentId) {
  return `/api/conversations/public-id/attachments/${attachmentId}`;
}

function descriptor(attachmentId, extra = {}) {
  return JSON.stringify({
    url: protectedUrl(attachmentId),
    mime: 'image/jpeg',
    ...extra,
  });
}

function assertImmutable(stored, submitted) {
  assert.throws(
    () => preserveMessageEditAttachments(stored, submitted),
    (error) => (
      error instanceof MessageEditAttachmentError &&
      error.status === 409 &&
      error.code === 'MESSAGE_EDIT_ATTACHMENTS_IMMUTABLE'
    ),
  );
}

test('message edit preserves the exact stored attachment values', () => {
  const stored = [descriptor(EXISTING_ID, { name: 'stored.jpg' })];
  const submittedDeliveryDescriptor = [JSON.stringify({
    url: 'https://vmd.invalid/v1/image',
    fallback_url: protectedUrl(EXISTING_ID),
    display_url: 'https://vmd.invalid/v1/image',
    name: 'client-copy.jpg',
  })];

  const result = preserveMessageEditAttachments(
    stored,
    submittedDeliveryDescriptor,
  );
  assert.deepEqual(result, stored);
  assert.notStrictEqual(result, stored);
});

test('omitting attachments means no mutation and preserves stored attachments', () => {
  const stored = [descriptor(EXISTING_ID)];
  assert.deepEqual(
    preserveMessageEditAttachments(stored, undefined),
    stored,
  );
});

test('message edit cannot remove or replace existing attachments', () => {
  const stored = [descriptor(EXISTING_ID)];
  assertImmutable(stored, []);
  assertImmutable(stored, [descriptor(STAGED_ID)]);
  assertImmutable(stored, [descriptor(EXISTING_ID), descriptor(STAGED_ID)]);
});

test('message edit rejects every newly introduced attachment class before lifecycle lookup', async (t) => {
  const cases = [
    ['staged attachment', descriptor(STAGED_ID)],
    ['foreign attachment', descriptor(FOREIGN_ID)],
    ['expired attachment', descriptor(EXPIRED_ID)],
    ['external attachment', 'https://evil.invalid/attachment.jpg'],
    ['arbitrary reference', 'not-an-attachment-reference'],
  ];

  for (const [name, submitted] of cases) {
    await t.test(name, () => {
      assertImmutable([], [submitted]);
    });
  }
});

test('non-array attachment edits are rejected', () => {
  assertImmutable([descriptor(EXISTING_ID)], descriptor(EXISTING_ID));
});

test('message edit route reads and emits stored attachments without updating the column', async () => {
  const source = await readFile(
    new URL(
      '../../../server/routes/conversations/messages/byId.js',
      import.meta.url,
    ),
    'utf8',
  );
  const editRoute = source.slice(
    source.indexOf("router.put('/:messageId'"),
    source.indexOf("router.delete('/:messageId'"),
  );

  assert.match(editRoute, /SELECT sender_id, is_deleted, message_type, attachments/i);
  assert.match(editRoute, /preserveMessageEditAttachments\(/);
  assert.match(editRoute, /attachments: storedAttachments/);
  assert.doesNotMatch(editRoute, /UPDATE messages SET[\s\S]*attachments\s*=/i);
});
