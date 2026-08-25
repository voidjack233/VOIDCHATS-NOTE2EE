import { randomUUID } from 'node:crypto';

const CLEANUP_LOCK_KEY = 'attachments:staged-cleanup:lock';
const CONTENT_ADDRESSED_SCAN_CURSOR_KEY =
  'attachments:content-addressed-blob-scan:cursor:v1';
const CLEANUP_LOCK_TTL_MS = 30 * 60 * 1000;
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

type CleanupSummary = Record<string, unknown>;

type UntrackedCleanupSummary = CleanupSummary & {
  scanComplete: boolean;
  nextCursor: string | null;
};

type AttachmentCleanupLifecycle = {
  config: { cleanupIntervalSeconds: number };
  cleanupExpiredStaged(): Promise<CleanupSummary>;
  cleanupOrphanedBlobs(): Promise<CleanupSummary>;
  cleanupUntrackedContentAddressedObjects(options: {
    startAfter: string;
  }): Promise<UntrackedCleanupSummary>;
};

type CleanupLockClient = {
  set(key: string, value: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: 'PX',
    durationMs: number,
    condition: 'NX',
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
};

type CleanupLogger = {
  error(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
};

type CleanupRunnerOptions = {
  lifecycle?: AttachmentCleanupLifecycle;
  lockClient?: CleanupLockClient;
  logger?: CleanupLogger;
};

export function createStagedAttachmentCleanupRunner({
  lifecycle,
  lockClient,
  logger = console,
}: CleanupRunnerOptions = {}) {
  if (
    !lifecycle ||
    typeof lifecycle.cleanupExpiredStaged !== 'function' ||
    typeof lifecycle.cleanupOrphanedBlobs !== 'function' ||
    typeof lifecycle.cleanupUntrackedContentAddressedObjects !== 'function'
  ) {
    throw new TypeError('Staged attachment cleanup requires a lifecycle service');
  }
  if (
    !lockClient ||
    typeof lockClient.set !== 'function' ||
    typeof lockClient.get !== 'function' ||
    typeof lockClient.del !== 'function' ||
    typeof lockClient.eval !== 'function'
  ) {
    throw new TypeError('Staged attachment cleanup requires a distributed lock client');
  }

  const activeLifecycle = lifecycle;
  const activeLockClient = lockClient;
  let interval: NodeJS.Timeout | null = null;
  let runPromise: Promise<unknown> | null = null;

  async function runOnce() {
    if (runPromise) {
      return runPromise;
    }

    runPromise = (async () => {
      const lockToken = randomUUID();
      let acquired = false;

      try {
        const lockResult = await activeLockClient.set(
          CLEANUP_LOCK_KEY,
          lockToken,
          'PX',
          CLEANUP_LOCK_TTL_MS,
          'NX',
        );
        acquired = lockResult === 'OK';
      } catch (error) {
        logger.error('[ATTACHMENT_CLEANUP] distributed lock unavailable; cleanup skipped', {
          error: error instanceof Error ? error.message : String(error || ''),
        });
        return { skipped: true, reason: 'lock_unavailable' };
      }

      if (!acquired) {
        return { skipped: true, reason: 'lock_held' };
      }

      try {
        const staged = await activeLifecycle.cleanupExpiredStaged();
        const blobs = await activeLifecycle.cleanupOrphanedBlobs();
        let startAfter = '';
        try {
          startAfter = await activeLockClient.get(CONTENT_ADDRESSED_SCAN_CURSOR_KEY) || '';
        } catch (error) {
          logger.warn('[ATTACHMENT_CLEANUP] content-addressed scan cursor unavailable', {
            error: error instanceof Error ? error.message : String(error || ''),
          });
        }

        const untrackedBlobs = await activeLifecycle.cleanupUntrackedContentAddressedObjects({
          startAfter,
        });
        try {
          if (untrackedBlobs.scanComplete || !untrackedBlobs.nextCursor) {
            await activeLockClient.del(CONTENT_ADDRESSED_SCAN_CURSOR_KEY);
          } else {
            await activeLockClient.set(
              CONTENT_ADDRESSED_SCAN_CURSOR_KEY,
              untrackedBlobs.nextCursor,
            );
          }
        } catch (error) {
          logger.warn('[ATTACHMENT_CLEANUP] failed to persist content-addressed scan cursor', {
            error: error instanceof Error ? error.message : String(error || ''),
          });
        }

        return { ...staged, blobs, untrackedBlobs };
      } finally {
        await activeLockClient.eval(
          RELEASE_LOCK_SCRIPT,
          1,
          CLEANUP_LOCK_KEY,
          lockToken,
        ).catch((error) => {
          logger.warn('[ATTACHMENT_CLEANUP] failed to release distributed lock', {
            error: error instanceof Error ? error.message : String(error || ''),
          });
        });
      }
    })();

    try {
      return await runPromise;
    } finally {
      runPromise = null;
    }
  }

  function start() {
    if (interval) {
      return;
    }
    interval = setInterval(
      () => void runOnce(),
      activeLifecycle.config.cleanupIntervalSeconds * 1000,
    );
    interval.unref?.();
  }

  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  return Object.freeze({
    runOnce,
    start,
    stop,
  });
}
