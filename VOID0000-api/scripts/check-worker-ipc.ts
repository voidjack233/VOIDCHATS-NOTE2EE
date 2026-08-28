import { checkUnixSocket } from '../server/health/unixSocket.js';
import { getAttachmentSanitizerSocketPath } from '../server/attachmentSanitizer/ipcProtocol.js';

const vmdSocketPath = String(process.env.VMD_TRANSFORM_SOCKET_PATH || '').trim();

if (!vmdSocketPath) {
  throw new Error('VMD_TRANSFORM_SOCKET_PATH is required');
}

await Promise.all([
  checkUnixSocket(getAttachmentSanitizerSocketPath()),
  checkUnixSocket(vmdSocketPath),
]);
