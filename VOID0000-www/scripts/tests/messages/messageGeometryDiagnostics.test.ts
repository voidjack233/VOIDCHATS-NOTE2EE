import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../../src/Services/Chat/chatTypes';
import {
  describeMessageGeometryTraits,
  selectCorrelatedMessageGeometryEvents,
  type MessageGeometryDebugEntry,
} from '../../../src/components/Chat/MessageView/messageGeometryDiagnostics';

const createMessage = (overrides: Partial<Message> = {}): Message => ({
  conversation_id: 'conversation-1',
  message_id: 'message-1',
  sender_id: 'user-1',
  content: 'hello',
  message_type: 'text',
  reply_to: null,
  is_edited: false,
  edited_at: null,
  is_deleted: false,
  created_at: '2026-08-20T00:00:00.000Z',
  ...overrides,
});

test('message geometry traits classify mixed async content without message text', () => {
  const traits = describeMessageGeometryTraits(createMessage({
    content: 'See https://void0000.online/invite/example',
    reply_to: 'parent-message',
    attachments: [
      JSON.stringify({ url: 'https://cdn.example/photo.jpg', mime: 'image/jpeg' }),
      JSON.stringify({ url: 'https://cdn.example/audio.ogg', mime: 'audio/ogg' }),
      JSON.stringify({ url: 'https://cdn.example/file.pdf', mime: 'application/pdf' }),
    ],
    reactions: { wave: ['user-2'] },
    link_preview: { url: 'https://example.com', title: 'Example' },
  }));

  assert.deepEqual(traits, {
    hasText: true,
    imageCount: 1,
    audioCount: 1,
    fileCount: 1,
    hasReply: true,
    hasReactions: true,
    hasLinkPreview: true,
    hasInviteEmbed: true,
  });
});

test('layout-shift correlation keeps only nearby geometry events in chronological order', () => {
  const entry = (sequence: number, event: string, at: number): MessageGeometryDebugEntry => ({
    sequence,
    event,
    at,
    wallTime: '2026-08-20T00:00:00.000Z',
  });
  const correlated = selectCorrelatedMessageGeometryEvents({
    entries: [
      entry(1, 'too_old', 400),
      entry(2, 'message_row_resize', 760),
      entry(3, 'history_anchor_restore', 995),
      entry(4, 'layout_shift', 1_000),
      entry(5, 'observer_followup', 1_015),
      entry(6, 'too_late', 1_100),
    ],
    shiftStartTime: 1_000,
    observedAt: 1_020,
    windowMs: 250,
  });

  assert.deepEqual(
    correlated.map(({ event, relativeToShiftMs }) => ({ event, relativeToShiftMs })),
    [
      { event: 'message_row_resize', relativeToShiftMs: -240 },
      { event: 'history_anchor_restore', relativeToShiftMs: -5 },
      { event: 'observer_followup', relativeToShiftMs: 15 },
    ],
  );
});

test('layout-shift correlation remains bounded to the newest events', () => {
  const entries = Array.from({ length: 40 }, (_, index): MessageGeometryDebugEntry => ({
    sequence: index + 1,
    event: `event-${index + 1}`,
    at: 900 + index,
    wallTime: '2026-08-20T00:00:00.000Z',
  }));

  const correlated = selectCorrelatedMessageGeometryEvents({
    entries,
    shiftStartTime: 1_000,
    observedAt: 1_050,
    limit: 5,
  });

  assert.equal(correlated.length, 5);
  assert.deepEqual(correlated.map((entry) => entry.sequence), [36, 37, 38, 39, 40]);
});
