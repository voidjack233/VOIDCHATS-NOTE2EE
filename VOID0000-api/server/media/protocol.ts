export const VIDEO_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
export const VIDEO_FINAL_MAX_BYTES = 10 * 1024 * 1024;
export const VIDEO_STREAM = 'media:video:jobs';
export const VIDEO_CONSUMER_GROUP = 'media-workers';
export const VIDEO_ACTIVE_STATUSES = ['uploading', 'queued', 'probing', 'processing', 'finalizing'] as const;

export function videoJobFields(ingestId: string, conversationId: string): [string, string, string, string] {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (![ingestId, conversationId].every(value => typeof value === 'string' && uuid.test(value) && value !== '00000000-0000-0000-0000-000000000000')) {
    throw new TypeError('Video jobs require canonical UUID identities');
  }
  return ['ingest_id', ingestId, 'conversation_id', conversationId];
}
