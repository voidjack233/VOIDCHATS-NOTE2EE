import os from 'os';
import path from 'path';

export const VMD_TRANSFORM_PROTOCOL_VERSION = 1;

export function getVmdTransformSocketPath(): string {
  const configuredPath = String(process.env.VMD_TRANSFORM_SOCKET_PATH || '').trim();
  const socketPath = configuredPath || path.join(
    os.tmpdir(),
    `voidapp-vmd-transform-${typeof process.getuid === 'function' ? process.getuid() : 'default'}`,
    'worker.sock',
  );

  if (!path.isAbsolute(socketPath) || socketPath.includes('\0')) {
    throw new Error('VMD_TRANSFORM_SOCKET_PATH must be an absolute path');
  }
  if (Buffer.byteLength(socketPath) > 100) {
    throw new Error('VMD_TRANSFORM_SOCKET_PATH is too long for a Unix socket');
  }
  return socketPath;
}
