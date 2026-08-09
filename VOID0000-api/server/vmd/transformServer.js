import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { runSharpWork } from '../imageProcessing/sharpWorkGate.js';
import {
  encodeControlFrame,
  resolvePositiveInteger,
  SocketFrameReader,
  writeSocket,
} from '../attachmentSanitizer/ipcProtocol.js';
import { transformVmdImage, VmdMediaError } from './imageVariants.js';

const VMD_TRANSFORM_PROTOCOL_VERSION = 1;
const DEFAULT_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_QUEUE_DEPTH = 8;
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024;
const DEFAULT_INPUT_TIMEOUT_MS = 15_000;

function resolveNonNegativeInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function getVmdTransformSocketPath() {
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

class VmdTransformTransportError extends Error {
  constructor(message, { code, status }) {
    super(message);
    this.name = 'VmdTransformTransportError';
    this.code = code;
    this.status = status;
  }
}

function capacityError() {
  return new VmdTransformTransportError('VMD transform worker is busy', {
    code: 'VMD_AT_CAPACITY',
    status: 503,
  });
}

function shutdownError() {
  return new VmdTransformTransportError('VMD transform worker is shutting down', {
    code: 'VMD_TRANSFORM_UNAVAILABLE',
    status: 503,
  });
}

function protocolError() {
  return new VmdTransformTransportError('VMD transform request is invalid', {
    code: 'VMD_TRANSFORM_PROTOCOL_ERROR',
    status: 400,
  });
}

class BoundedVmdTransformQueue {
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

    const reservation = { payloadLength, state: 'reserved' };
    this.reservations.add(reservation);
    this.pendingBytes += payloadLength;
    return reservation;
  }

  release(reservation) {
    if (!this.reservations.delete(reservation)) return;
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

function validateTransformRequest(message, maxSourceBytes) {
  if (
    message.version !== VMD_TRANSFORM_PROTOCOL_VERSION ||
    message.operation !== 'transform' ||
    !['thumb', 'small', 'medium', 'large'].includes(message.variant) ||
    !Number.isSafeInteger(message.payloadLength) ||
    message.payloadLength <= 0 ||
    message.payloadLength > maxSourceBytes
  ) {
    if (Number(message.payloadLength) > maxSourceBytes) {
      throw new VmdTransformTransportError(
        'Attachment exceeds the VMD source limit',
        { code: 'VMD_SOURCE_TOO_LARGE', status: 413 },
      );
    }
    throw protocolError();
  }
}

function serializeError(error) {
  if (error instanceof VmdMediaError || error instanceof VmdTransformTransportError) {
    return {
      version: VMD_TRANSFORM_PROTOCOL_VERSION,
      type: 'error',
      status: error.status,
      code: error.code,
      message: error.message,
    };
  }
  return {
    version: VMD_TRANSFORM_PROTOCOL_VERSION,
    type: 'error',
    status: 500,
    code: 'VMD_TRANSFORM_FAILED',
    message: 'VMD image transformation failed',
  };
}

async function sendError(socket, error) {
  if (socket.destroyed || !socket.writable) return;
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
    if (error?.code === 'ENOENT') return;
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
    throw new Error(`VMD transform socket is already active: ${socketPath}`);
  }
  await fs.unlink(socketPath);
}

async function ensurePrivateSocketDirectory(socketPath) {
  const directory = path.dirname(socketPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) {
    throw new Error(`VMD transform socket parent is not a directory: ${directory}`);
  }
  if (
    typeof process.getuid === 'function' &&
    Number.isInteger(stat.uid) &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(`VMD transform socket directory has the wrong owner: ${directory}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`VMD transform socket directory must be mode 0700: ${directory}`);
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
      console.error('VMD transform socket cleanup failed:', error);
    }
  }
}

export async function startVmdTransformServer(options = {}) {
  const socketPath = options.socketPath || getVmdTransformSocketPath();
  const maxSourceBytes = resolvePositiveInteger(
    options.maxSourceBytes ?? process.env.VMD_MAX_SOURCE_BYTES,
    DEFAULT_MAX_SOURCE_BYTES,
    64 * 1024 * 1024,
  );
  const maxOutputBytes = resolvePositiveInteger(
    options.maxOutputBytes ?? process.env.VMD_MAX_VARIANT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
    64 * 1024 * 1024,
  );
  const concurrency = resolvePositiveInteger(
    options.concurrency ?? process.env.VMD_TRANSFORM_WORKER_CONCURRENCY,
    DEFAULT_CONCURRENCY,
    4,
  );
  const queueDepth = resolveNonNegativeInteger(
    options.queueDepth ?? process.env.VMD_TRANSFORM_WORKER_QUEUE_DEPTH,
    DEFAULT_QUEUE_DEPTH,
    32,
  );
  const maxPendingBytes = resolvePositiveInteger(
    options.maxPendingBytes ?? process.env.VMD_TRANSFORM_WORKER_MAX_PENDING_BYTES,
    DEFAULT_MAX_PENDING_BYTES,
    256 * 1024 * 1024,
  );
  const inputTimeoutMs = resolvePositiveInteger(
    options.inputTimeoutMs ?? process.env.VMD_TRANSFORM_INPUT_TIMEOUT_MS,
    DEFAULT_INPUT_TIMEOUT_MS,
    60_000,
  );
  const transform = options.transform || transformVmdImage;
  const executeSharpWork = options.runSharpWork || runSharpWork;
  const workQueue = new BoundedVmdTransformQueue({
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
    const reader = new SocketFrameReader(socket, {
      maxBufferedBytes: maxSourceBytes + 4 * 1024 + 4,
    });
    let reservation = null;
    let requestSubmitted = false;

    socket.once('close', () => {
      sockets.delete(socket);
      reader.dispose();
      if (!requestSubmitted) workQueue.cancel(reservation);
    });
    socket.setTimeout(inputTimeoutMs, () => {
      void sendError(socket, new VmdTransformTransportError(
        'VMD transform input timed out',
        { code: 'VMD_TRANSFORM_TIMEOUT', status: 408 },
      ));
    });

    void (async () => {
      try {
        if (closing) throw shutdownError();
        const request = await reader.readControlFrame();
        if (
          request.version === VMD_TRANSFORM_PROTOCOL_VERSION &&
          request.operation === 'ping'
        ) {
          await writeSocket(socket, encodeControlFrame({
            version: VMD_TRANSFORM_PROTOCOL_VERSION,
            type: 'pong',
          }));
          socket.end();
          return;
        }

        validateTransformRequest(request, maxSourceBytes);
        reservation = workQueue.reserve(request.payloadLength);
        await writeSocket(socket, encodeControlFrame({
          version: VMD_TRANSFORM_PROTOCOL_VERSION,
          type: 'ready',
        }));

        const source = await reader.readExactly(request.payloadLength);
        if (reader.bufferedBytes !== 0) throw protocolError();
        socket.setTimeout(0);
        requestSubmitted = true;

        const result = await workQueue.submit(
          reservation,
          () => executeSharpWork(() => transform(source, request.variant)),
        );
        if (
          !Buffer.isBuffer(result?.body) ||
          result.body.length === 0 ||
          result.body.length > maxOutputBytes ||
          result.contentType !== 'image/webp' ||
          !Number.isSafeInteger(result.width) || result.width <= 0 ||
          !Number.isSafeInteger(result.height) || result.height <= 0 ||
          !Number.isSafeInteger(result.pages) || result.pages <= 0
        ) {
          throw new VmdTransformTransportError(
            'VMD transform result is invalid',
            { code: 'VMD_TRANSFORM_FAILED', status: 500 },
          );
        }

        await writeSocket(socket, encodeControlFrame({
          version: VMD_TRANSFORM_PROTOCOL_VERSION,
          type: 'result',
          payloadLength: result.body.length,
          metadata: {
            contentType: result.contentType,
            width: result.width,
            height: result.height,
            pages: result.pages,
          },
        }));
        await writeSocket(socket, result.body);
        socket.end();
      } catch (error) {
        if (
          !(error instanceof VmdMediaError) &&
          !(error instanceof VmdTransformTransportError) &&
          !socket.destroyed
        ) {
          console.error('VMD transform IPC request failed:', error);
        }
        if (!requestSubmitted) workQueue.cancel(reservation);
        await sendError(socket, error);
      }
    })();
  });

  server.on('error', (error) => {
    if (!closing) console.error('VMD transform IPC server error:', error);
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
      if (closing) return;
      closing = true;
      workQueue.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      await unlinkOwnedSocket(socketPath);
    },
  };
}
