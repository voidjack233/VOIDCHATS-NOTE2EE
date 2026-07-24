import {
  AttachmentSanitizerTransportError,
  ChatImageSanitizationError,
} from '../utils/chatImageErrors.js';
import {
  ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
  connectToUnixSocket,
  encodeControlFrame,
  getAttachmentSanitizerSocketPath,
  MAX_ATTACHMENT_SANITIZER_PAYLOAD_BYTES,
  resolvePositiveInteger,
  SocketFrameReader,
  writeSocket,
} from './ipcProtocol.js';

const DEFAULT_OPERATION_TIMEOUT_MS = 90_000;
const MAX_OPERATION_TIMEOUT_MS = 5 * 60_000;

function unavailableError(code = 'ATTACHMENT_SANITIZER_UNAVAILABLE') {
  return new AttachmentSanitizerTransportError(
    'Attachment image processing is temporarily unavailable',
    { code, status: code === 'ATTACHMENT_SANITIZER_TIMEOUT' ? 504 : 503 },
  );
}

function createRemoteError(message) {
  const status = Number.isInteger(message.status) ? message.status : 500;
  const code = typeof message.code === 'string'
    ? message.code
    : 'ATTACHMENT_SANITIZER_FAILED';
  const safeMessage = typeof message.message === 'string'
    ? message.message
    : 'Attachment image processing failed';

  if (
    code === 'ATTACHMENT_TOO_LARGE' ||
    code.startsWith('ATTACHMENT_IMAGE_')
  ) {
    return new ChatImageSanitizationError(safeMessage, { code, status });
  }

  return new AttachmentSanitizerTransportError(safeMessage, {
    code,
    status,
    retryable: typeof message.retryable === 'boolean'
      ? message.retryable
      : status >= 500,
  });
}

function assertResultMetadata(message) {
  const metadata = message.metadata;
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    typeof metadata.contentType !== 'string' ||
    !metadata.contentType.startsWith('image/') ||
    !Number.isSafeInteger(metadata.width) ||
    metadata.width <= 0 ||
    !Number.isSafeInteger(metadata.height) ||
    metadata.height <= 0 ||
    !Number.isSafeInteger(metadata.pages) ||
    metadata.pages <= 0 ||
    typeof metadata.animated !== 'boolean' ||
    typeof metadata.sourceFormat !== 'string'
  ) {
    throw unavailableError('ATTACHMENT_SANITIZER_PROTOCOL_ERROR');
  }
  return metadata;
}

/**
 * Sends raw bytes only over a local Unix socket. The worker returns either a
 * sanitized image buffer or a non-image marker; no upload bytes enter Valkey.
 */
export async function sanitizeChatAttachmentImageInWorker(
  source,
  claimedMime,
  options = {},
) {
  if (!Buffer.isBuffer(source) || source.length === 0) {
    throw new ChatImageSanitizationError('Attachment payload is invalid', {
      code: 'ATTACHMENT_IMAGE_INVALID',
      status: 400,
    });
  }
  if (source.length > MAX_ATTACHMENT_SANITIZER_PAYLOAD_BYTES) {
    throw new ChatImageSanitizationError(
      'File too large. Maximum 10MB per attachment.',
      {
        code: 'ATTACHMENT_TOO_LARGE',
        status: 413,
      },
    );
  }

  const socketPath = options.socketPath || getAttachmentSanitizerSocketPath();
  const timeoutMs = resolvePositiveInteger(
    options.timeoutMs ?? process.env.ATTACHMENT_SANITIZER_TIMEOUT_MS,
    DEFAULT_OPERATION_TIMEOUT_MS,
    MAX_OPERATION_TIMEOUT_MS,
  );
  const socket = (options.connect || connectToUnixSocket)(socketPath);
  const reader = new SocketFrameReader(socket);

  let timeout;
  const operation = (async () => {
    await new Promise((resolve, reject) => {
      if (socket.readyState === 'open') {
        resolve();
        return;
      }
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    await writeSocket(socket, encodeControlFrame({
      version: ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
      operation: 'sanitize',
      payloadLength: source.length,
      claimedMime: typeof claimedMime === 'string'
        ? claimedMime.slice(0, 255)
        : 'application/octet-stream',
    }));

    const ready = await reader.readControlFrame();
    if (ready.type === 'error') {
      throw createRemoteError(ready);
    }
    if (
      ready.type !== 'ready' ||
      ready.version !== ATTACHMENT_SANITIZER_PROTOCOL_VERSION
    ) {
      throw unavailableError('ATTACHMENT_SANITIZER_PROTOCOL_ERROR');
    }

    await writeSocket(socket, source);

    const result = await reader.readControlFrame();
    if (result.type === 'error') {
      throw createRemoteError(result);
    }
    if (
      result.type !== 'result' ||
      result.version !== ATTACHMENT_SANITIZER_PROTOCOL_VERSION
    ) {
      throw unavailableError('ATTACHMENT_SANITIZER_PROTOCOL_ERROR');
    }
    if (result.kind === 'non-image' && result.payloadLength === 0) {
      return null;
    }
    if (
      result.kind !== 'image' ||
      !Number.isSafeInteger(result.payloadLength) ||
      result.payloadLength <= 0 ||
      result.payloadLength > MAX_ATTACHMENT_SANITIZER_PAYLOAD_BYTES
    ) {
      throw unavailableError('ATTACHMENT_SANITIZER_PROTOCOL_ERROR');
    }

    const metadata = assertResultMetadata(result);
    const buffer = await reader.readExactly(result.payloadLength);
    return {
      buffer,
      contentType: metadata.contentType,
      width: metadata.width,
      height: metadata.height,
      pages: metadata.pages,
      animated: metadata.animated,
      sourceFormat: metadata.sourceFormat,
    };
  })();

  const timedOperation = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      socket.destroy();
      reject(unavailableError('ATTACHMENT_SANITIZER_TIMEOUT'));
    }, timeoutMs);
    timeout.unref?.();
    operation.then(resolve, reject);
  });

  try {
    return await timedOperation;
  } catch (error) {
    if (
      error instanceof ChatImageSanitizationError ||
      error instanceof AttachmentSanitizerTransportError
    ) {
      throw error;
    }
    throw unavailableError();
  } finally {
    clearTimeout(timeout);
    reader.dispose();
    socket.destroy();
  }
}
