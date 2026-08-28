import net from 'node:net';

const DEFAULT_TIMEOUT_MS = 1_000;

export async function checkUnixSocket(
  socketPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (!socketPath || !socketPath.startsWith('/')) {
    throw new Error('Unix socket path must be absolute');
  }

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Unix socket connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeAllListeners();
    };

    socket.once('connect', () => {
      cleanup();
      socket.end();
      resolve();
    });
    socket.once('error', (error) => {
      cleanup();
      socket.destroy();
      reject(error);
    });
  });
}
