import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import {
  encodeControlFrame,
  SocketFrameReader,
  writeSocket,
} from '../../../server/attachmentSanitizer/ipcProtocol.js';
import { startVmdTransformServer } from '../../../server/vmd/transformServer.js';

async function connect(socketPath) {
  const socket = net.createConnection({ path: socketPath });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function requestTransform(socketPath, source, variant) {
  const socket = await connect(socketPath);
  const reader = new SocketFrameReader(socket, {
    maxBufferedBytes: 20 * 1024 * 1024,
  });
  try {
    await writeSocket(socket, encodeControlFrame({
      version: 1,
      operation: 'transform',
      variant,
      payloadLength: source.length,
    }));
    const ready = await reader.readControlFrame();
    assert.equal(ready.type, 'ready');
    await writeSocket(socket, source);
    const result = await reader.readControlFrame();
    assert.equal(result.type, 'result');
    const body = await reader.readExactly(result.payloadLength);
    return { result, body };
  } finally {
    reader.dispose();
    socket.destroy();
  }
}

test('VMD transform socket responds to readiness ping', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'void-vmd-transform-test-'));
  const socketPath = path.join(directory, 'worker.sock');
  const server = await startVmdTransformServer({ socketPath });
  t.after(async () => {
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const socket = await connect(socketPath);
  const reader = new SocketFrameReader(socket);
  try {
    await writeSocket(socket, encodeControlFrame({
      version: 1,
      operation: 'ping',
    }));
    const response = await reader.readControlFrame();
    assert.deepEqual(response, { version: 1, type: 'pong' });
  } finally {
    reader.dispose();
    socket.destroy();
  }
});

test('VMD transform socket returns a bounded WebP variant through Sharp', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'void-vmd-transform-test-'));
  const socketPath = path.join(directory, 'worker.sock');
  const server = await startVmdTransformServer({ socketPath });
  t.after(async () => {
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const source = await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: '#287f6f',
    },
  }).png().toBuffer();

  const { result, body } = await requestTransform(socketPath, source, 'small');
  assert.equal(result.metadata.contentType, 'image/webp');
  assert.equal(result.metadata.width, 480);
  assert.equal(result.metadata.height, 360);
  assert.equal(result.metadata.pages, 1);
  assert.ok(body.length > 0);

  const metadata = await sharp(body).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 480);
  assert.equal(metadata.height, 360);
});
