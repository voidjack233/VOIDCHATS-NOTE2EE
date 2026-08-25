import fs from 'fs/promises';
import net, { type Socket } from 'net';
import os from 'os';
import path from 'path';
import { runSharpWork } from '../imageProcessing/sharpWorkGate.js';
import {
  encodeControlFrame,
  resolvePositiveInteger,
  SocketFrameReader,
  writeSocket,
} from '../attachmentSanitizer/ipcProtocol.js';
import {
  transformVmdImage,
  VmdMediaError,
  type VmdTransformedImage,
} from './imageVariants.js';
import { isVmdImageVariant, type VmdImageVariant } from './capability.js';

const VMD_TRANSFORM_PROTOCOL_VERSION = 1;
const DEFAULT_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_QUEUE_DEPTH = 8;
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024;
const DEFAULT_INPUT_TIMEOUT_MS = 15_000;

type ReservationState = 'reserved' | 'queued' | 'active' | 'released';

type QueueReservation = {
  payloadLength: number;
  state: ReservationState;
};

type QueueItem = {
  reservation: QueueReservation;
  task: () => unknown | PromiseLike<unknown>;
  resolve: (result: unknown) => void;
  reject: (reason: unknown) => void;
};

type TransformRequest = {
  version: number;
  operation: 'transform';
  variant: VmdImageVariant;
  payloadLength: number;
};

type SharpWorkRunner = <Result>(
  task: () => Result | PromiseLike<Result>,
) => Promise<Result>;

export type VmdTransformServerOptions = {
  socketPath?: string;
  maxSourceBytes?: unknown;
  maxOutputBytes?: unknown;
  concurrency?: unknown;
  queueDepth?: unknown;
  maxPendingBytes?: unknown;
  inputTimeoutMs?: unknown;
  transform?: (
    source: Buffer,
    variant: VmdImageVariant,
  ) => unknown | PromiseLike<unknown>;
  runSharpWork?: SharpWorkRunner;
};

type QueueStats = {
  active: number;
  queued: number;
  reserved: number;
  pendingBytes: number;
  concurrency: number;
  maxReservations: number;
  maxPendingBytes: number;
};

export type VmdTransformServer = {
  socketPath: string;
  getStats(): QueueStats;
  close(): Promise<void>;
};

function isNodeErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function resolveNonNegativeInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function getVmdTransformSocketPath(): string {
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
  readonly code: string;
  readonly status: number;

  constructor(message: string, { code, status }: { code: string; status: number }) {
    super(message);
    this.name = 'VmdTransformTransportError';
    this.code = code;
    this.status = status;
  }
}

function capacityError(): VmdTransformTransportError {
  return new VmdTransformTransportError('VMD transform worker is busy', {
    code: 'VMD_AT_CAPACITY',
    status: 503,
  });
}

function shutdownError(): VmdTransformTransportError {
  return new VmdTransformTransportError('VMD transform worker is shutting down', {
    code: 'VMD_TRANSFORM_UNAVAILABLE',
    status: 503,
  });
}

function protocolError(): VmdTransformTransportError {
  return new VmdTransformTransportError('VMD transform request is invalid', {
    code: 'VMD_TRANSFORM_PROTOCOL_ERROR',
    status: 400,
  });
}

class BoundedVmdTransformQueue {
  readonly concurrency: number;
  readonly maxReservations: number;
  readonly maxPendingBytes: number;
  active: number;
  pendingBytes: number;
  readonly reservations: Set<QueueReservation>;
  readonly queue: QueueItem[];
  closed: boolean;

  constructor({
    concurrency,
    queueDepth,
    maxPendingBytes,
  }: {
    concurrency: number;
    queueDepth: number;
    maxPendingBytes: number;
  }) {
    this.concurrency = concurrency;
    this.maxReservations = concurrency + queueDepth;
    this.maxPendingBytes = maxPendingBytes;
    this.active = 0;
    this.pendingBytes = 0;
    this.reservations = new Set();
    this.queue = [];
    this.closed = false;
  }

  reserve(payloadLength: number): QueueReservation {
    if (
      this.closed ||
      this.reservations.size >= this.maxReservations ||
      this.pendingBytes + payloadLength > this.maxPendingBytes
    ) {
      throw capacityError();
    }

    const reservation: QueueReservation = { payloadLength, state: 'reserved' };
    this.reservations.add(reservation);
    this.pendingBytes += payloadLength;
    return reservation;
  }

  release(reservation: QueueReservation): void {
    if (!this.reservations.delete(reservation)) return;
    this.pendingBytes -= reservation.payloadLength;
    reservation.state = 'released';
  }

  cancel(reservation: QueueReservation | null): void {
    if (reservation?.state === 'reserved') {
      this.release(reservation);
    }
  }

  submit(
    reservation: QueueReservation,
    task: () => unknown | PromiseLike<unknown>,
  ): Promise<unknown> {
    if (
      this.closed ||
      !this.reservations.has(reservation) ||
      reservation.state !== 'reserved'
    ) {
      this.cancel(reservation);
      return Promise.reject(shutdownError());
    }

    reservation.state = 'queued';
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({ reservation, task, resolve, reject });
      this.drain();
    });
  }

  drain(): void {
    while (!this.closed && this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) return;
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

  close(): void {
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

  getStats(): QueueStats {
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

function validateTransformRequest(
  message: Record<string, unknown>,
  maxSourceBytes: number,
): asserts message is Record<string, unknown> & TransformRequest {
  if (
    message.version !== VMD_TRANSFORM_PROTOCOL_VERSION ||
    message.operation !== 'transform' ||
    !isVmdImageVariant(message.variant) ||
    typeof message.payloadLength !== 'number' ||
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

function serializeError(error: unknown): Record<string, unknown> {
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

async function sendError(socket: Socket, error: unknown): Promise<void> {
  if (socket.destroyed || !socket.writable) return;
  try {
    await writeSocket(socket, encodeControlFrame(serializeError(error)));
    socket.end();
  } catch {
    socket.destroy();
  }
}

async function socketPathIsActive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = net.createConnection({ path: socketPath });
    const finish = (active: boolean) => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(active);
    };
    probe.once('connect', () => finish(true));
    probe.once('error', () => finish(false));
    probe.setTimeout(250, () => finish(false));
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(socketPath);
  } catch (error) {
    if (isNodeErrorWithCode(error) && error.code === 'ENOENT') return;
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

async function ensurePrivateSocketDirectory(socketPath: string): Promise<void> {
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

async function unlinkOwnedSocket(socketPath: string): Promise<void> {
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
    if (!isNodeErrorWithCode(error) || error.code !== 'ENOENT') {
      console.error('VMD transform socket cleanup failed:', error);
    }
  }
}

function isValidTransformResult(
  result: unknown,
  maxOutputBytes: number,
): result is VmdTransformedImage {
  if (!result || typeof result !== 'object') return false;
  const candidate = result as Partial<VmdTransformedImage>;
  return Buffer.isBuffer(candidate.body) &&
    candidate.body.length > 0 &&
    candidate.body.length <= maxOutputBytes &&
    candidate.contentType === 'image/webp' &&
    typeof candidate.width === 'number' &&
    Number.isSafeInteger(candidate.width) && candidate.width > 0 &&
    typeof candidate.height === 'number' &&
    Number.isSafeInteger(candidate.height) && candidate.height > 0 &&
    typeof candidate.pages === 'number' &&
    Number.isSafeInteger(candidate.pages) && candidate.pages > 0;
}

export async function startVmdTransformServer(
  options: VmdTransformServerOptions = {},
): Promise<VmdTransformServer> {
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
  const sockets = new Set<Socket>();
  let closing = false;

  await ensurePrivateSocketDirectory(socketPath);
  await removeStaleSocket(socketPath);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    const reader = new SocketFrameReader(socket, {
      maxBufferedBytes: maxSourceBytes + 4 * 1024 + 4,
    });
    let reservation: QueueReservation | null = null;
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
        if (!isValidTransformResult(result, maxOutputBytes)) {
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
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      await unlinkOwnedSocket(socketPath);
    },
  };
}
