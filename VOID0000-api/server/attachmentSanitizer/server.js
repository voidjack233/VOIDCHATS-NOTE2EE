import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import {
  AttachmentSanitizerTransportError,
  ChatImageSanitizationError,
} from '../utils/chatImageErrors.js';
import { sanitizeChatAttachmentImage } from '../utils/chatImageSanitizer.js';
import { runSharpWork } from '../imageProcessing/sharpWorkGate.js';
import {
  ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
  encodeControlFrame,
  getAttachmentSanitizerSocketPath,
  MAX_ATTACHMENT_SANITIZER_PAYLOAD_BYTES,
  resolvePositiveInteger,
  SocketFrameReader,
  writeSocket,
} from './ipcProtocol.js';

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_QUEUE_DEPTH = 3;
const DEFAULT_MAX_PENDING_BYTES = 30 * 1024 * 1024;
const DEFAULT_INPUT_TIMEOUT_MS = 15_000;

function capacityError() {
  return new AttachmentSanitizerTransportError(
    'Attachment image processing is busy. Try again shortly.',
    {
      code: 'ATTACHMENT_SANITIZER_BUSY',
      status: 503,
      retryable: true,
    },
  );
}

function shutdownError() {
  return new AttachmentSanitizerTransportError(
    'Attachment image processing is shutting down',
    {
      code: 'ATTACHMENT_SANITIZER_UNAVAILABLE',
      status: 503,
      retryable: true,
    },
  );
}

class BoundedAttachmentWorkQueue {
  constructor({ concurrency, queueDepth, maxPendingBytes }) {
    this.concurrency = concurrency;
    this.maxReservations = concurrency + queueDepth;
    this.maxPendingBytes = maxPendingBytes;
    this.active = 0;
    this.pendingBytes = 0;
    this.reservations = new Set();
    this.queue = [];
    this.closed = false;
  }

  reserve(payloadLength) {
    if (
      this.closed ||
      this.reservations.size >= this.maxReservations ||
      this.pendingBytes + payloadLength > this.maxPendingBytes
    ) {
      throw capacityError();
    }

    const reservation = {
      payloadLength,
      state: 'reserved',
    };
    this.reservations.add(reservation);
    this.pendingBytes += payloadLength;
    return reservation;
  }

  release(reservation) {
    if (!this.reservations.delete(reservation)) {
      return;
    }
    this.pendingBytes -= reservation.payloadLength;
    reservation.state = 'released';
  }

  cancel(reservation) {
    if (reservation?.state === 'reserved') {
      this.release(reservation);
    }
  }

  submit(reservation, task) {
    if (
      this.closed ||
      !this.reservations.has(reservation) ||
      reservation.state !== 'reserved'
    ) {
      this.cancel(reservation);
      return Promise.reject(shutdownError());
    }

    reservation.state = 'queued';
    return new Promise((resolve, reject) => {
      this.queue.push({ reservation, task, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (!this.closed && this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      item.reservation.state = 'active';
      this.active += 1;

      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.release(item.reservation);
          this.drain();
        });
    }
  }

  close() {
    this.closed = true;
    const error = shutdownError();
    for (const item of this.queue.splice(0)) {
      this.release(item.reservation);
      item.reject(error);
    }
    for (const reservation of [...this.reservations]) {
      if (reservation.state === 'reserved') {
        this.release(reservation);
      }
    }
  }

  getStats() {
    return {
      active: this.active,
      queued: this.queue.length,
      reserved: this.reservations.size,
      pendingBytes: this.pendingBytes,
      concurrency: this.concurrency,
      maxReservations: this.maxReservations,
      maxPendingBytes: this.maxPendingBytes,
    };
  }
}

function validateRequest(message) {
  if (
    message.version !== ATTACHMENT_SANITIZER_PROTOCOL_VERSION ||
    message.operation !== 'sanitize' ||
    !Number.isSafeInteger(message.payloadLength) ||
    message.payloadLength <= 0 ||
    message.payloadLength > MAX_ATTACHMENT_SANITIZER_PAYLOAD_BYTES ||
    typeof message.claimedMime !== 'string' ||
    message.claimedMime.length === 0 ||
    message.claimedMime.length > 255
  ) {
    throw new AttachmentSanitizerTransportError(
      'Attachment sanitizer request is invalid',
      {
        code: message.payloadLength > MAX_ATTACHMENT_SANITIZER_PAYLOAD_BYTES
          ? 'ATTACHMENT_TOO_LARGE'
          : 'ATTACHMENT_SANITIZER_PROTOCOL_ERROR',
        status: message.payloadLength > MAX_ATTACHMENT_SANITIZER_PAYLOAD_BYTES ? 413 : 400,
        retryable: false,
      },
    );
  }
}

function serializeError(error) {
  if (
    error instanceof ChatImageSanitizationError ||
    error instanceof AttachmentSanitizerTransportError
  ) {
    return {
      version: ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
      type: 'error',
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error instanceof AttachmentSanitizerTransportError
        ? { retryable: error.retryable }
        : {}),
    };
  }

  return {
    version: ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
    type: 'error',
    status: 500,
    code: 'ATTACHMENT_SANITIZER_FAILED',
    message: 'Attachment image processing failed',
    retryable: true,
  };
}

async function sendError(socket, error) {
  if (socket.destroyed || !socket.writable) {
    return;
  }
  try {
    await writeSocket(socket, encodeControlFrame(serializeError(error)));
    socket.end();
  } catch {
    socket.destroy();
  }
}

async function socketPathIsActive(socketPath) {
  return new Promise((resolve) => {
    const probe = net.createConnection({ path: socketPath });
    const finish = (active) => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(active);
    };
    probe.once('connect', () => finish(true));
    probe.once('error', () => finish(false));
    probe.setTimeout(250, () => finish(false));
  });
}

async function removeStaleSocket(socketPath) {
  let stat;
  try {
    stat = await fs.lstat(socketPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (!stat.isSocket()) {
    throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
  }
  if (
    typeof process.getuid === 'function' &&
    Number.isInteger(stat.uid) &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(`Refusing to replace socket owned by another user: ${socketPath}`);
  }
  if (await socketPathIsActive(socketPath)) {
    throw new Error(`Attachment sanitizer socket is already active: ${socketPath}`);
  }

  await fs.unlink(socketPath);
}

async function ensurePrivateSocketDirectory(socketPath) {
  const directory = path.dirname(socketPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.stat(directory);

  if (!stat.isDirectory()) {
    throw new Error(`Attachment sanitizer socket parent is not a directory: ${directory}`);
  }
  if (
    typeof process.getuid === 'function' &&
    Number.isInteger(stat.uid) &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(`Attachment sanitizer socket directory has the wrong owner: ${directory}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `Attachment sanitizer socket directory must be mode 0700: ${directory}`,
    );
  }
}

async function unlinkOwnedSocket(socketPath) {
  try {
    const stat = await fs.lstat(socketPath);
    if (
      stat.isSocket() &&
      (
        typeof process.getuid !== 'function' ||
        !Number.isInteger(stat.uid) ||
        stat.uid === process.getuid()
      )
    ) {
      await fs.unlink(socketPath);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('Attachment sanitizer socket cleanup failed:', error);
    }
  }
}

export async function startAttachmentSanitizerServer(options = {}) {
  const socketPath = options.socketPath || getAttachmentSanitizerSocketPath();
  const concurrency = resolvePositiveInteger(
    options.concurrency ?? process.env.ATTACHMENT_SANITIZER_CONCURRENCY,
    DEFAULT_CONCURRENCY,
    2,
  );
  const queueDepth = resolvePositiveInteger(
    options.queueDepth ?? process.env.ATTACHMENT_SANITIZER_QUEUE_DEPTH,
    DEFAULT_QUEUE_DEPTH,
    16,
  );
  const maxPendingBytes = resolvePositiveInteger(
    options.maxPendingBytes ?? process.env.ATTACHMENT_SANITIZER_MAX_PENDING_BYTES,
    DEFAULT_MAX_PENDING_BYTES,
    160 * 1024 * 1024,
  );
  const inputTimeoutMs = resolvePositiveInteger(
    options.inputTimeoutMs ?? process.env.ATTACHMENT_SANITIZER_INPUT_TIMEOUT_MS,
    DEFAULT_INPUT_TIMEOUT_MS,
    60_000,
  );
  const sanitize = options.sanitize || sanitizeChatAttachmentImage;
  const executeSharpWork = options.runSharpWork || runSharpWork;
  const workQueue = new BoundedAttachmentWorkQueue({
    concurrency,
    queueDepth,
    maxPendingBytes,
  });
  const sockets = new Set();
  let closing = false;

  await ensurePrivateSocketDirectory(socketPath);
  await removeStaleSocket(socketPath);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    const reader = new SocketFrameReader(socket);
    let reservation = null;
    let requestSubmitted = false;

    socket.once('close', () => {
      sockets.delete(socket);
      reader.dispose();
      if (!requestSubmitted) {
        workQueue.cancel(reservation);
      }
    });

    socket.setTimeout(inputTimeoutMs, () => {
      void sendError(socket, new AttachmentSanitizerTransportError(
        'Attachment sanitizer input timed out',
        {
          code: 'ATTACHMENT_SANITIZER_TIMEOUT',
          status: 408,
          retryable: true,
        },
      ));
    });

    void (async () => {
      try {
        if (closing) {
          throw shutdownError();
        }

        const request = await reader.readControlFrame();
        validateRequest(request);
        reservation = workQueue.reserve(request.payloadLength);

        await writeSocket(socket, encodeControlFrame({
          version: ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
          type: 'ready',
        }));

        const source = await reader.readExactly(request.payloadLength);
        if (reader.bufferedBytes !== 0) {
          throw new AttachmentSanitizerTransportError(
            'Attachment sanitizer request contained trailing bytes',
            {
              code: 'ATTACHMENT_SANITIZER_PROTOCOL_ERROR',
              status: 400,
              retryable: false,
            },
          );
        }
        socket.setTimeout(0);
        requestSubmitted = true;

        const result = await workQueue.submit(
          reservation,
          () => executeSharpWork(() => sanitize(source, request.claimedMime)),
        );

        if (!result) {
          await writeSocket(socket, encodeControlFrame({
            version: ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
            type: 'result',
            kind: 'non-image',
            payloadLength: 0,
          }));
          socket.end();
          return;
        }

        await writeSocket(socket, encodeControlFrame({
          version: ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
          type: 'result',
          kind: 'image',
          payloadLength: result.buffer.length,
          metadata: {
            contentType: result.contentType,
            width: result.width,
            height: result.height,
            pages: result.pages,
            animated: result.animated,
            sourceFormat: result.sourceFormat,
          },
        }));
        await writeSocket(socket, result.buffer);
        socket.end();
      } catch (error) {
        if (!(error instanceof ChatImageSanitizationError)) {
          const knownTransportError = error instanceof AttachmentSanitizerTransportError;
          if (!knownTransportError && !socket.destroyed) {
            console.error('Attachment sanitizer IPC request failed:', error);
          }
        }
        if (!requestSubmitted) {
          workQueue.cancel(reservation);
        }
        await sendError(socket, error);
      }
    })();
  });

  server.on('error', (error) => {
    if (!closing) {
      console.error('Attachment sanitizer IPC server error:', error);
    }
  });

  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(socketPath);
  });
  try {
    await fs.chmod(socketPath, 0o600);
  } catch (error) {
    await new Promise((resolve) => server.close(() => resolve()));
    await unlinkOwnedSocket(socketPath);
    throw error;
  }

  return {
    socketPath,
    getStats: () => workQueue.getStats(),
    async close() {
      if (closing) {
        return;
      }
      closing = true;
      workQueue.close();

      await new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) {
          socket.destroy();
        }
      });
      await unlinkOwnedSocket(socketPath);
    },
  };
}
