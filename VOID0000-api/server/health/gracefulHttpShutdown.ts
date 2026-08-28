import type { Server } from 'node:http';

type ShutdownHook = () => unknown | PromiseLike<unknown>;

interface GracefulHttpShutdownOptions {
  service: string;
  hooks?: ShutdownHook[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

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
    deadline.unref?.();

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
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
