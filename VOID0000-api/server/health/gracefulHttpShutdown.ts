import type { Server } from 'node:http';

type ShutdownHook = () => unknown | PromiseLike<unknown>;

interface GracefulHttpShutdownOptions {
  service: string;
  hooks?: ShutdownHook[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const POST_CLEANUP_EXIT_MS = 500;

export function installGracefulHttpShutdown(
  server: Server,
  {
    service,
    hooks = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: GracefulHttpShutdownOptions,
): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${service} received ${signal}, draining HTTP connections...`);

    const deadline = setTimeout(() => {
      console.error(`${service} graceful shutdown timed out`);
      server.closeAllConnections?.();
      process.exit(1);
    }, timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections?.();
      });
      const results = await Promise.allSettled(
        hooks.map((hook) => Promise.resolve().then(hook)),
      );
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length > 0) {
        failed.forEach((result) => {
          if (result.status === 'rejected') {
            console.error(`${service} shutdown hook failed:`, result.reason);
          }
        });
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`${service} graceful shutdown failed:`, error);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      // PM2 keeps its IPC pipe ref'ed. Once all work is drained, disconnect it
      // so the process can exit naturally and the supervisor can replace it.
      try {
        if (process.connected) process.disconnect();
      } catch (error) {
        console.error(`${service} supervisor IPC disconnect failed:`, error);
        process.exitCode = 1;
      }
      // Let a clean process exit naturally. A forgotten live handle must not
      // leave a non-listening process reported online indefinitely.
      const postCleanupExit = setTimeout(() => {
        console.error(`${service} remained alive after shutdown cleanup`);
        process.exit(process.exitCode ?? 0);
      }, POST_CLEANUP_EXIT_MS);
      postCleanupExit.unref?.();
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
