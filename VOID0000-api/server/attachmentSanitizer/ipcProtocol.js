import net from 'net';
import os from 'os';
import path from 'path';
import { MAX_CHAT_ATTACHMENT_BYTES } from '../utils/chatImageLimits.js';

export const ATTACHMENT_SANITIZER_PROTOCOL_VERSION = 1;
export const MAX_ATTACHMENT_SANITIZER_HEADER_BYTES = 4 * 1024;
export const MAX_ATTACHMENT_SANITIZER_PAYLOAD_BYTES = MAX_CHAT_ATTACHMENT_BYTES;

const DEFAULT_SOCKET_DIRECTORY = `voidapp-attachment-sanitizer-${
  typeof process.getuid === 'function' ? process.getuid() : 'default'
}`;

export function resolvePositiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

export function getAttachmentSanitizerSocketPath() {
  const configuredPath = String(
    process.env.ATTACHMENT_SANITIZER_SOCKET_PATH || '',
  ).trim();
  const socketPath = configuredPath || path.join(
    os.tmpdir(),
    DEFAULT_SOCKET_DIRECTORY,
    'worker.sock',
  );

  if (!path.isAbsolute(socketPath) || socketPath.includes('\0')) {
    throw new Error('ATTACHMENT_SANITIZER_SOCKET_PATH must be an absolute path');
  }
  if (Buffer.byteLength(socketPath) > 100) {
    throw new Error('ATTACHMENT_SANITIZER_SOCKET_PATH is too long for a Unix socket');
  }

  return socketPath;
}

export function encodeControlFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (
    payload.length === 0 ||
    payload.length > MAX_ATTACHMENT_SANITIZER_HEADER_BYTES
  ) {
    throw new Error('Attachment sanitizer control frame is invalid');
  }

  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export async function writeSocket(socket, buffer) {
  if (socket.destroyed || !socket.writable) {
    throw new Error('Attachment sanitizer socket is not writable');
  }
  if (socket.write(buffer)) {
    return;
  }
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('drain', handleDrain);
      socket.off('error', handleError);
      socket.off('close', handleClose);
    };
    const handleDrain = () => {
      cleanup();
      resolve();
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };
    const handleClose = () => {
      cleanup();
      reject(new Error('Attachment sanitizer socket closed during write'));
    };

    socket.once('drain', handleDrain);
    socket.once('error', handleError);
    socket.once('close', handleClose);
  });
}

export class SocketFrameReader {
  constructor(
    socket,
    {
      maxBufferedBytes = MAX_ATTACHMENT_SANITIZER_PAYLOAD_BYTES +
        MAX_ATTACHMENT_SANITIZER_HEADER_BYTES +
        4,
    } = {},
  ) {
    this.socket = socket;
    this.maxBufferedBytes = maxBufferedBytes;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.pendingRead = null;
    this.terminalError = null;

    this.handleData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (this.bufferedBytes + buffer.length > this.maxBufferedBytes) {
        const error = new Error('Attachment sanitizer socket buffer exceeded its limit');
        this.finish(error);
        socket.destroy(error);
        return;
      }
      this.chunks.push(buffer);
      this.bufferedBytes += buffer.length;
      this.flushPendingRead();
    };
    this.handleError = (error) => {
      this.finish(error);
    };
    this.handleEnd = () => {
      this.finish(new Error('Attachment sanitizer socket ended unexpectedly'));
    };
    this.handleClose = () => {
      this.finish(new Error('Attachment sanitizer socket closed unexpectedly'));
    };

    socket.on('data', this.handleData);
    socket.once('error', this.handleError);
    socket.once('end', this.handleEnd);
    socket.once('close', this.handleClose);
  }

  finish(error) {
    if (!this.terminalError) {
      this.terminalError = error;
    }
    if (this.pendingRead) {
      const { reject } = this.pendingRead;
      this.pendingRead = null;
      reject(this.terminalError);
    }
  }

  consume(length) {
    if (length === 0) {
      return Buffer.alloc(0);
    }
    if (this.bufferedBytes < length) {
      return null;
    }

    const first = this.chunks[0];
    if (first.length === length) {
      this.chunks.shift();
      this.bufferedBytes -= length;
      return first;
    }
    if (first.length > length) {
      const result = first.subarray(0, length);
      this.chunks[0] = first.subarray(length);
      this.bufferedBytes -= length;
      return result;
    }

    const result = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.chunks[0];
      const remaining = length - offset;
      const consumed = Math.min(chunk.length, remaining);
      chunk.copy(result, offset, 0, consumed);
      offset += consumed;

      if (consumed === chunk.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(consumed);
      }
    }
    this.bufferedBytes -= length;
    return result;
  }

  flushPendingRead() {
    if (!this.pendingRead) {
      return;
    }
    const value = this.consume(this.pendingRead.length);
    if (!value) {
      return;
    }

    const { resolve } = this.pendingRead;
    this.pendingRead = null;
    resolve(value);
  }

  readExactly(length) {
    if (!Number.isSafeInteger(length) || length < 0) {
      return Promise.reject(new Error('Attachment sanitizer frame length is invalid'));
    }
    if (this.pendingRead) {
      return Promise.reject(new Error('Concurrent socket frame reads are not supported'));
    }

    const value = this.consume(length);
    if (value) {
      return Promise.resolve(value);
    }
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }

    return new Promise((resolve, reject) => {
      this.pendingRead = { length, resolve, reject };
    });
  }

  async readControlFrame() {
    const prefix = await this.readExactly(4);
    const length = prefix.readUInt32BE(0);
    if (
      length === 0 ||
      length > MAX_ATTACHMENT_SANITIZER_HEADER_BYTES
    ) {
      throw new Error('Attachment sanitizer control frame exceeds its limit');
    }

    const payload = await this.readExactly(length);
    let message;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch {
      throw new Error('Attachment sanitizer control frame is not valid JSON');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('Attachment sanitizer control frame must be an object');
    }
    return message;
  }

  dispose() {
    this.socket.off('data', this.handleData);
    this.socket.off('error', this.handleError);
    this.socket.off('end', this.handleEnd);
    this.socket.off('close', this.handleClose);
  }
}

export function connectToUnixSocket(socketPath) {
  return net.createConnection({ path: socketPath });
}
