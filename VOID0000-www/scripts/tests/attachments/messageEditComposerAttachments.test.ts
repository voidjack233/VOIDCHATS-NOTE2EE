import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  canStartComposerAttachmentUpload,
  cleanupPendingComposerAttachmentsForEdit,
  discardCompletedComposerUpload,
} from '../../../src/Services/hooks/Chats/composerAttachmentPolicy';

const CONVERSATION_ID = 'conversation-1';
const STORED_ID = '11111111-1111-4111-8111-111111111111';
const STAGED_ID = '22222222-2222-4222-8222-222222222222';
const LATE_ID = '33333333-3333-4333-8333-333333333333';

function attachmentUrl(id: string): string {
  return `/api/conversations/public-id/attachments/${id}`;
}

function storedDescriptor(id = STORED_ID): string {
  return JSON.stringify({
    id,
    url: `https://cdn.invalid/signed/${id}`,
    fallback_url: attachmentUrl(id),
  });
}

test('edit mode blocks the shared file-selection and paste upload gate', () => {
  assert.equal(canStartComposerAttachmentUpload({
    attachmentsAllowed: true,
    editingMessageActive: true,
  }), false);
  assert.equal(canStartComposerAttachmentUpload({
    attachmentsAllowed: true,
    editingMessageActive: false,
  }), true);
  assert.equal(canStartComposerAttachmentUpload({
    attachmentsAllowed: false,
    editingMessageActive: false,
  }), false);
});

test('entering edit mode removes pending drafts and cleans only staged composer uploads', async () => {
  const removedUploadingIds = new Set<string>();
  const deleted: string[] = [];

  await cleanupPendingComposerAttachmentsForEdit({
    conversationId: CONVERSATION_ID,
    deleteStaged: async (_conversationId, rawAttachment) => {
      deleted.push(rawAttachment);
    },
    pendingAttachments: [
      {
        id: 'upload-in-progress',
        uploading: true,
        url: null,
      },
      {
        id: 'staged-draft',
        uploading: false,
        url: attachmentUrl(STAGED_ID),
      },
      {
        id: 'defensive-stored-overlap',
        uploading: false,
        url: attachmentUrl(STORED_ID),
      },
    ],
    removedUploadingIds,
    storedMessageAttachments: [storedDescriptor()],
  });

  assert.deepEqual([...removedUploadingIds], ['upload-in-progress']);
  assert.deepEqual(deleted, [attachmentUrl(STAGED_ID)]);
});

test('upload completion after edit begins is deleted best-effort', async () => {
  const removedUploadingIds = new Set(['late-upload']);
  const deleted: string[] = [];

  const discarded = await discardCompletedComposerUpload({
    attachmentId: 'late-upload',
    conversationId: CONVERSATION_ID,
    deleteStaged: async (_conversationId, rawAttachment) => {
      deleted.push(rawAttachment);
    },
    editModeActive: false,
    removedUploadingIds,
    uploadedUrl: attachmentUrl(LATE_ID),
  });

  assert.equal(discarded, true);
  assert.equal(removedUploadingIds.size, 0);
  assert.deepEqual(deleted, [attachmentUrl(LATE_ID)]);
});

test('active edit mode discards a late upload even if its removal marker raced', async () => {
  const deleted: string[] = [];

  const discarded = await discardCompletedComposerUpload({
    attachmentId: 'late-upload-without-marker',
    conversationId: CONVERSATION_ID,
    deleteStaged: async (_conversationId, rawAttachment) => {
      deleted.push(rawAttachment);
    },
    editModeActive: true,
    removedUploadingIds: new Set(),
    uploadedUrl: attachmentUrl(LATE_ID),
  });

  assert.equal(discarded, true);
  assert.deepEqual(deleted, [attachmentUrl(LATE_ID)]);
});

test('stored attachments of the edited message are never staged for deletion', async () => {
  const deleted: string[] = [];

  const discarded = await discardCompletedComposerUpload({
    attachmentId: 'defensive-overlap',
    conversationId: CONVERSATION_ID,
    deleteStaged: async (_conversationId, rawAttachment) => {
      deleted.push(rawAttachment);
    },
    editModeActive: true,
    removedUploadingIds: new Set(),
    storedMessageAttachments: [storedDescriptor()],
    uploadedUrl: attachmentUrl(STORED_ID),
  });

  assert.equal(discarded, true);
  assert.deepEqual(deleted, []);
});

test('composer wires selection, paste, retry, and picker actions through the edit gate', async () => {
  const hookSource = await readFile(
    new URL(
      '../../../src/Services/hooks/Chats/useMessageInput.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const inputSource = await readFile(
    new URL(
      '../../../src/components/Chat/Composer/MessageInput.tsx',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(hookSource, /const addFiles[\s\S]+if \(!attachmentsEnabled\) return/);
  assert.match(hookSource, /const handlePaste[\s\S]+if \(!attachmentsEnabled\) return/);
  assert.match(
    hookSource,
    /const handleFileChange[\s\S]+if \(attachmentsEnabled && event\.target\.files\)/,
  );
  assert.match(hookSource, /const retryAttachment[\s\S]+if \(!attachmentsEnabled\) return/);
  assert.match(inputSource, /disabled=\{!attachmentsEnabled\}/);
  assert.match(inputSource, /onDrop=\{blockEditModeFileDrop\}/);
  assert.match(inputSource, /\{!editingMessage \? \(/);
});
