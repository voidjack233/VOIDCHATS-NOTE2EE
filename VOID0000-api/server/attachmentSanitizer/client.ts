import type { Socket } from 'net';
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
import type {
  ChatImageFormat,
  SanitizedChatAttachmentImage,
} from '../utils/chatImageSanitizer.js';

const DEFAULT_OPERATION_TIMEOUT_MS = 90_000;
const MAX_OPERATION_TIMEOUT_MS = 5 * 60_000;

type ControlFrame = Record<string, unknown>;

type ResultMetadata = Omit<SanitizedChatAttachmentImage, 'buffer'>;

export type AttachmentSanitizerClientOptions = {
  socketPath?: string;
  timeoutMs?: unknown;
  connect?: (socketPath: string) => Socket;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isChatImageFormat(value: unknown): value is ChatImageFormat {
  return value === 'jpeg' ||
    value === 'png' ||
    value === 'webp' ||
    value === 'gif' ||
    value === 'tiff' ||
    value === 'avif';
}

function unavailableError(
  code = 'ATTACHMENT_SANITIZER_UNAVAILABLE',
): AttachmentSanitizerTransportError {
  return new AttachmentSanitizerTransportError(
    'Attachment image processing is temporarily unavailable',
    { code, status: code === 'ATTACHMENT_SANITIZER_TIMEOUT' ? 504 : 503 },
  );
}

function createRemoteError(message: ControlFrame): Error {
  const status = typeof message.status === 'number' && Number.isInteger(message.status)
    ? message.status
    : 500;
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

function assertResultMetadata(message: ControlFrame): ResultMetadata {
  const metadata = message.metadata;
  if (
    !isRecord(metadata) ||
    typeof metadata.contentType !== 'string' ||
    !metadata.contentType.startsWith('image/') ||
    !isPositiveSafeInteger(metadata.width) ||
    !isPositiveSafeInteger(metadata.height) ||
    !isPositiveSafeInteger(metadata.pages) ||
    typeof metadata.animated !== 'boolean' ||
    !isChatImageFormat(metadata.sourceFormat)
  ) {
    throw unavailableError('ATTACHMENT_SANITIZER_PROTOCOL_ERROR');
  }
  return {
    contentType: metadata.contentType,
    width: metadata.width,
    height: metadata.height,
    pages: metadata.pages,
    animated: metadata.animated,
    sourceFormat: metadata.sourceFormat,
  };
}

/**
 * Sends raw bytes only over a local Unix socket. The worker returns either a
 * sanitized image buffer or a non-image marker; no upload bytes enter Valkey.
 */
export async function sanitizeChatAttachmentImageInWorker(
  source: unknown,
  claimedMime: unknown,
  options: AttachmentSanitizerClientOptions = {},
): Promise<SanitizedChatAttachmentImage | null> {
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

  let timeout: NodeJS.Timeout | undefined;
  const operation = (async () => {
    await new Promise<void>((resolve, reject) => {
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
      !isPositiveSafeInteger(result.payloadLength) ||
      result.payloadLength > MAX_ATTACHMENT_SANITIZER_PAYLOAD_BYTES
    ) {
      throw unavailableError('ATTACHMENT_SANITIZER_PROTOCOL_ERROR');
    }

    const metadata = assertResultMetadata(result);
    const payloadLength = result.payloadLength;
    if (typeof payloadLength !== 'number') {
      throw unavailableError('ATTACHMENT_SANITIZER_PROTOCOL_ERROR');
    }
    const buffer = await reader.readExactly(payloadLength);
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

  const timedOperation = new Promise<SanitizedChatAttachmentImage | null>((resolve, reject) => {
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
    if (timeout) clearTimeout(timeout);
    reader.dispose();
    socket.destroy();
  }
}
