import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
  pingIpcControlSocket,
} from '../../../server/attachmentSanitizer/ipcProtocol.js';
import { startAttachmentSanitizerServer } from '../../../server/attachmentSanitizer/server.js';

test('attachment sanitizer readiness uses protocol ping without queueing work', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'void-sanitizer-ipc-test-'));
  const socketPath = path.join(directory, 'worker.sock');
  let sanitizeCalls = 0;
  const server = await startAttachmentSanitizerServer({
    socketPath,
    sanitize: () => {
      sanitizeCalls += 1;
      return null;
    },
  });
  t.after(async () => {
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await pingIpcControlSocket(socketPath, ATTACHMENT_SANITIZER_PROTOCOL_VERSION);

  assert.equal(sanitizeCalls, 0);
  assert.deepEqual(server.getStats(), {
    active: 0,
    queued: 0,
    reserved: 0,
    pendingBytes: 0,
    concurrency: 1,
    maxReservations: 4,
    maxPendingBytes: 30 * 1024 * 1024,
  });
});

test('IPC readiness rejects a socket that accepts connections without speaking the protocol', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'void-silent-ipc-test-'));
  const socketPath = path.join(directory, 'worker.sock');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(
    pingIpcControlSocket(socketPath, ATTACHMENT_SANITIZER_PROTOCOL_VERSION, 50),
    /timed out/,
  );
});
