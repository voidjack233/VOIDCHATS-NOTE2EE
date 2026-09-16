import { fetchWithAuth } from '../Auth/authServiceApi';
import { assertAuthOperation, captureAuthOperation } from '../Auth/client/authOperationScope';
import { CHAT_API_PREFIX } from './chatUtils';
import type { Attachment } from './chatTypes';
import { MAX_ATTACHMENT_FILE_BYTES } from './attachmentUploadPolicy';

export interface VideoUploadOptions {
  onVideoStatus?: (status: string) => void;
  shouldCancel?: () => boolean;
}
export const isMp4Candidate = (file: Pick<File, 'type' | 'name'>) =>
  file.type.toLowerCase() === 'video/mp4' || /\.mp4$/i.test(file.name);

function failure(code: string, status?: number) {
  return Object.assign(new Error('Video could not be processed. Remove it or retry.'), { code, status });
}

export async function uploadVideo(conversationId: string, file: File, options: VideoUploadOptions = {}): Promise<Attachment> {
  if (!file.size || file.size > MAX_ATTACHMENT_FILE_BYTES) throw failure('MEDIA_SOURCE_SIZE_INVALID', 413);
  const scope = captureAuthOperation();
  const id = crypto.randomUUID();
  const base = `${CHAT_API_PREFIX}/${conversationId}/attachments/video-ingests`;
  const cancel = async () => {
    assertAuthOperation(scope);
    await fetchWithAuth(`${base}/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) }).catch(() => {});
  };
  const check = () => {
    assertAuthOperation(scope);
    if (options.shouldCancel?.()) throw failure('MEDIA_UPLOAD_CANCELLED');
  };
  try {
    check();
    options.onVideoStatus?.('Uploading video...');
    const upload = await fetchWithAuth(base, { method: 'POST', body: file, signal: AbortSignal.timeout(125_000),
      headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Ingest-Id': id,
        'X-Attachment-Filename': encodeURIComponent(file.name.slice(0, 180)) } });
    check();
    if (!upload.ok) throw failure((await upload.json().catch(() => null))?.code || 'MEDIA_UPLOAD_FAILED', upload.status);
    // This polls one asynchronous ingest, never message history or render URLs.
    // A deadline bounds abandoned drafts; it is not a video-duration restriction.
    const deadline = Date.now() + 24 * 60_000;
    let temporaryFailures = 0;
    while (Date.now() < deadline) {
      check();
      const response = await fetchWithAuth(`${base}/${id}`, { signal: AbortSignal.timeout(15_000) });
      check();
      if (!response.ok) {
        if (response.status < 500 || ++temporaryFailures > 10) throw failure('MEDIA_STATUS_UNAVAILABLE', response.status);
      } else {
        temporaryFailures = 0;
        const result = await response.json();
        check();
        if (result.status === 'ready') {
          const attachment = result.attachment as Attachment | undefined;
          if (!attachment?.url || attachment.mime !== 'video/mp4' || !(attachment.width! > 0) || !(attachment.height! > 0)) throw failure('MEDIA_RESULT_INVALID');
          options.onVideoStatus?.('Ready');
          return { ...attachment, name: file.name };
        }
        if (result.status === 'failed' || result.status === 'cancelled') throw failure(result.error_code || 'MEDIA_PROCESS_FAILED');
        options.onVideoStatus?.(result.status === 'queued' ? 'Waiting to process...' : 'Processing video...');
      }
      await new Promise<void>(resolve => setTimeout(resolve, 1500));
    }
    throw failure('MEDIA_PROCESS_TIMEOUT');
  } catch (error) {
    // Never borrow a replacement account's cookies/CSRF to cancel old work.
    assertAuthOperation(scope);
    await cancel();
    throw error;
  }
}
