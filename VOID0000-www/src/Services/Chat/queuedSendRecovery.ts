import { gateway } from '../Gateway/gateway';
import { debugLog } from '../utils/debugLog';
import { sendImageOnlyMessage, sendMessage } from './messageService';
import { queuedSendStore, type QueuedSendRecord } from './queuedSendStore';
import type { Message } from './chatTypes';

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const RETRY_JITTER_RATIO = 0.2;
const CROSS_TAB_LOCK_NAME = 'void:queued-send-recovery';

type FlushResult = 'complete' | 'retry' | 'busy';

export type QueuedSendOutcome =
  | {
      status: 'sent';
      record: QueuedSendRecord;
      message: Message;
    }
  | {
      status: 'failed';
      record: QueuedSendRecord;
      message: Message;
      notice: string;
    };

type QueuedSendOutcomeListener = (outcome: QueuedSendOutcome) => void;

const outcomeListeners = new Set<QueuedSendOutcomeListener>();

function getQueueKey(record: QueuedSendRecord): string {
  return `${record.conversation_id}:${record.local_client_id}`;
}

function getFailureStatus(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return Number(candidate.status ?? candidate.statusCode) || 0;
}

function getFailureCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function getFailureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== 'object') return '';
  const message = (error as { message?: unknown; error?: unknown }).message ??
    (error as { error?: unknown }).error;
  return typeof message === 'string' ? message : '';
}

export function isTransientMessageSendFailure(error: unknown): boolean {
  const status = getFailureStatus(error);
  const code = getFailureCode(error);
  const message = getFailureMessage(error).toLowerCase();

  return (
    code === 'AUTH_SESSION_UNAVAILABLE' ||
    code === 'REQUEST_TIMEOUT' ||
    (error as { name?: string } | null)?.name === 'AbortError' ||
    status === 401 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500 ||
    message.includes('timed out') ||
    message.includes('failed to fetch') ||
    message.includes('network') ||
    message.includes('unavailable')
  );
}

function buildLocalMessage(record: QueuedSendRecord, localStatus: 'failed'): Message {
  return {
    conversation_id: record.conversation_id,
    message_id: record.local_client_id,
    sender_id: record.sender_id,
    content: record.text,
    message_type: 'text',
    reply_to: record.reply_to_id,
    attachments: record.uploaded_urls,
    is_edited: false,
    edited_at: null,
    is_deleted: false,
    created_at: record.created_at,
    reactions: {},
    link_preview: record.link_preview ?? undefined,
    mentions: record.mentions ?? undefined,
    local_status: localStatus,
    local_client_id: record.local_client_id,
  };
}

function emitOutcome(outcome: QueuedSendOutcome): void {
  outcomeListeners.forEach((listener) => {
    try {
      listener(outcome);
    } catch (error) {
      console.error('[QUEUED_SEND] outcome listener failed', error);
    }
  });
}

function getTerminalFailureNotice(error: unknown): string {
  return getFailureMessage(error) || 'A queued message could not be sent. Retry it from the message.';
}

class QueuedSendRecovery {
  private activeUserId: string | null = null;
  private generation = 0;
  private retryAttempt = 0;
  private retryTimer: number | null = null;
  private retryDueAt = 0;
  private flushPromise: Promise<FlushResult> | null = null;
  private rerunRequested = false;
  private inFlightKeys = new Set<string>();

  private handleRecoverySignal = () => {
    this.requestFlush(true);
  };

  private handleOffline = () => {
    this.clearRetryTimer();
  };

  private handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      this.requestFlush(true);
    }
  };

  start(userId: string): void {
    if (this.activeUserId === userId) {
      this.requestFlush(true);
      return;
    }

    this.stop();
    this.activeUserId = userId;
    this.generation += 1;

    window.addEventListener('online', this.handleRecoverySignal);
    window.addEventListener('offline', this.handleOffline);
    window.addEventListener('focus', this.handleRecoverySignal);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    gateway.on('READY', this.handleRecoverySignal);
    gateway.on('RESUMED', this.handleRecoverySignal);

    this.requestFlush(true);
  }

  stop(expectedUserId?: string): void {
    if (expectedUserId && this.activeUserId !== expectedUserId) return;

    this.generation += 1;
    this.activeUserId = null;
    this.retryAttempt = 0;
    this.rerunRequested = false;
    this.clearRetryTimer();
    this.inFlightKeys.clear();

    window.removeEventListener('online', this.handleRecoverySignal);
    window.removeEventListener('offline', this.handleOffline);
    window.removeEventListener('focus', this.handleRecoverySignal);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    gateway.off('READY', this.handleRecoverySignal);
    gateway.off('RESUMED', this.handleRecoverySignal);
  }

  notifyQueued(record: QueuedSendRecord): void {
    if (record.sender_id !== this.activeUserId || !navigator.onLine) return;
    if (this.flushPromise) {
      this.rerunRequested = true;
      return;
    }
    this.scheduleRetry();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDueAt = 0;
  }

  private setRetryTimer(delayMs: number): boolean {
    if (!this.activeUserId || !navigator.onLine) return false;

    const dueAt = Date.now() + delayMs;
    if (this.retryTimer !== null && this.retryDueAt <= dueAt) return false;

    this.clearRetryTimer();
    this.retryDueAt = dueAt;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.retryDueAt = 0;
      void this.flush();
    }, delayMs);
    return true;
  }

  private requestFlush(resetBackoff: boolean): void {
    if (!this.activeUserId || !navigator.onLine) return;
    if (resetBackoff) this.retryAttempt = 0;

    this.clearRetryTimer();
    if (this.flushPromise) {
      this.rerunRequested = true;
      return;
    }

    this.setRetryTimer(0);
  }

  private scheduleRetry(): void {
    if (!this.activeUserId || !navigator.onLine) return;

    const exponentialDelay = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * (2 ** Math.min(this.retryAttempt, 5)),
    );
    const jitter = exponentialDelay * RETRY_JITTER_RATIO * ((Math.random() * 2) - 1);
    const delayMs = Math.min(
      RETRY_MAX_MS,
      Math.max(RETRY_BASE_MS, Math.round(exponentialDelay + jitter)),
    );
    if (this.setRetryTimer(delayMs)) {
      this.retryAttempt = Math.min(this.retryAttempt + 1, 6);
    }
  }

  private async flush(): Promise<void> {
    if (!this.activeUserId || !navigator.onLine) return;
    if (this.flushPromise) {
      this.rerunRequested = true;
      return;
    }

    const userId = this.activeUserId;
    const generation = this.generation;
    this.rerunRequested = false;
    const flushPromise = this.runWithCrossTabLock(userId, generation);
    this.flushPromise = flushPromise;

    let result: FlushResult = 'retry';
    try {
      result = await flushPromise;
    } catch (error) {
      console.error('[QUEUED_SEND] recovery scan failed', error);
    } finally {
      if (this.flushPromise === flushPromise) {
        this.flushPromise = null;
      }
    }

    if (this.generation !== generation || this.activeUserId !== userId) {
      if (this.activeUserId && this.rerunRequested) {
        this.rerunRequested = false;
        this.requestFlush(false);
      }
      return;
    }

    if (result === 'retry' || result === 'busy') {
      this.rerunRequested = false;
      this.scheduleRetry();
      return;
    }

    this.retryAttempt = 0;
    if (this.rerunRequested) {
      this.rerunRequested = false;
      this.requestFlush(false);
    }
  }

  private async runWithCrossTabLock(userId: string, generation: number): Promise<FlushResult> {
    if (!navigator.locks) {
      return this.flushRecords(userId, generation);
    }

    return navigator.locks.request(
      CROSS_TAB_LOCK_NAME,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => lock ? this.flushRecords(userId, generation) : 'busy',
    );
  }

  private async flushRecords(userId: string, generation: number): Promise<FlushResult> {
    const queuedSends = (await queuedSendStore.getAll())
      .filter((record) => record.sender_id === userId)
      .sort((left, right) => (
        new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
      ));

    if (queuedSends.length === 0) return 'complete';

    debugLog('[QUEUED_SEND] recovery scan', { count: queuedSends.length });

    for (const record of queuedSends) {
      if (this.generation !== generation || this.activeUserId !== userId) {
        return 'complete';
      }

      const queueKey = getQueueKey(record);
      if (this.inFlightKeys.has(queueKey)) continue;
      this.inFlightKeys.add(queueKey);

      try {
        const options = {
          client_message_id: record.local_client_id,
          reply_to: record.reply_to_id || undefined,
          linkPreview: record.link_preview || null,
          mentions: record.mentions || [],
        };
        const message = record.text.trim()
          ? await sendMessage(record.conversation_id, record.text, {
              ...options,
              attachments: record.uploaded_urls,
            })
          : await sendImageOnlyMessage(record.conversation_id, record.uploaded_urls, options);

        await queuedSendStore.remove(record.conversation_id, record.local_client_id);
        emitOutcome({
          status: 'sent',
          record,
          message: {
            ...message,
            local_status: 'sent',
            local_client_id: record.local_client_id,
          },
        });
        debugLog('[QUEUED_SEND] recovered', { queueKey });
      } catch (error) {
        if (isTransientMessageSendFailure(error)) {
          debugLog('[QUEUED_SEND] recovery deferred', {
            queueKey,
            code: getFailureCode(error) || getFailureStatus(error) || 'TRANSIENT',
          });
          return 'retry';
        }

        await queuedSendStore.remove(record.conversation_id, record.local_client_id)
          .catch((removeError) => {
            console.error('[QUEUED_SEND] failed to remove terminal queue record', removeError);
          });
        emitOutcome({
          status: 'failed',
          record,
          message: buildLocalMessage(record, 'failed'),
          notice: getTerminalFailureNotice(error),
        });
      } finally {
        this.inFlightKeys.delete(queueKey);
      }
    }

    return 'complete';
  }
}

export const queuedSendRecovery = new QueuedSendRecovery();

export async function enqueueQueuedSend(record: QueuedSendRecord): Promise<void> {
  await queuedSendStore.put(record);
  queuedSendRecovery.notifyQueued(record);
}

export function subscribeQueuedSendOutcomes(listener: QueuedSendOutcomeListener): () => void {
  outcomeListeners.add(listener);
  return () => outcomeListeners.delete(listener);
}
