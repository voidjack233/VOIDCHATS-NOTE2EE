import { randomUUID } from 'node:crypto';

const CLEANUP_LOCK_KEY = 'attachments:staged-cleanup:lock';
const CLEANUP_LOCK_TTL_MS = 30 * 60 * 1000;
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export function createStagedAttachmentCleanupRunner({
  lifecycle,
  lockClient,
  logger = console,
} = {}) {
  if (!lifecycle || typeof lifecycle.cleanupExpiredStaged !== 'function') {
    throw new TypeError('Staged attachment cleanup requires a lifecycle service');
  }
  if (
    !lockClient ||
    typeof lockClient.set !== 'function' ||
    typeof lockClient.eval !== 'function'
  ) {
    throw new TypeError('Staged attachment cleanup requires a distributed lock client');
  }

  let interval = null;
  let runPromise = null;

  async function runOnce() {
    if (runPromise) {
      return runPromise;
    }

    runPromise = (async () => {
      const lockToken = randomUUID();
      let acquired = false;

      try {
        const lockResult = await lockClient.set(
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
        return await lifecycle.cleanupExpiredStaged();
      } finally {
        await lockClient.eval(
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
      lifecycle.config.cleanupIntervalSeconds * 1000,
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
