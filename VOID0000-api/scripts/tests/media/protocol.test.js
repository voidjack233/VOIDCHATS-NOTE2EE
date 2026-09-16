import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { VIDEO_SOURCE_MAX_BYTES, VIDEO_FINAL_MAX_BYTES, VIDEO_STREAM, VIDEO_CONSUMER_GROUP, videoJobFields } from '../../../server/media/protocol.js';

test('video jobs contain only canonical ingest/conversation identities, never media', () => {
  const id = 'a1111111-1111-4111-8111-111111111111';
  const conversation = randomUUID();
  assert.deepEqual(videoJobFields(id, conversation), ['ingest_id', id, 'conversation_id', conversation]);
  assert.equal(VIDEO_STREAM, 'media:video:jobs');
  assert.equal(VIDEO_CONSUMER_GROUP, 'media-workers');
  for (const bad of ['', 'arbitrary.mp4', '0'.repeat(36), '00000000-0000-0000-0000-000000000000', id.toUpperCase(), Buffer.alloc(10)]) {
    assert.throws(() => videoJobFields(bad, conversation));
    assert.throws(() => videoJobFields(id, bad));
  }
});

test('source and finalized MP4 both have independent 10 MiB bounds', () => {
  assert.equal(VIDEO_SOURCE_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(VIDEO_FINAL_MAX_BYTES, 10 * 1024 * 1024);
});
