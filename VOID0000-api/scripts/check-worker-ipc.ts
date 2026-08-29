import {
  ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
  getAttachmentSanitizerSocketPath,
  pingIpcControlSocket,
} from '../server/attachmentSanitizer/ipcProtocol.js';
import {
  getVmdTransformSocketPath,
  VMD_TRANSFORM_PROTOCOL_VERSION,
} from '../server/vmd/transformProtocol.js';

await Promise.all([
  pingIpcControlSocket(
    getAttachmentSanitizerSocketPath(),
    ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
  ),
  pingIpcControlSocket(
    getVmdTransformSocketPath(),
    VMD_TRANSFORM_PROTOCOL_VERSION,
  ),
]);
