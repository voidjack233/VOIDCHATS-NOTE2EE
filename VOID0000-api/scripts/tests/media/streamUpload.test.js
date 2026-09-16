import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from 'minio';
import { streamQuarantineUpload, videoContentLength } from '../../../server/media/streamUpload.js';

test('quarantine forwards bytes before source completion with bounded backpressure', async () => {
  let received = 0;
  const server = createServer((req, res) => { req.on('data', b => { received += b.length; }); req.on('end', () => res.end()); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const source = Readable.from((async function* () {
      yield Buffer.alloc(65536, 7);
      for (let tries = 0; received === 0 && tries < 100; tries++) await delay(10);
      assert.ok(received > 0, 'transport buffered instead of forwarding first chunk');
      for (let i = 1; i < 160; i++) yield Buffer.alloc(65536, 7);
    })());
    assert.equal(await streamQuarantineUpload(source, `http://127.0.0.1:${server.address().port}/object`, 10485760), 10485760);
    assert.equal(received, 10485760);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('size declarations and counted limits reject invalid uploads', async () => {
  assert.equal(videoContentLength('10485760'), 10485760);
  assert.equal(videoContentLength(undefined), undefined);
  for (const invalid of ['0', '-1', '10485761', '1.1', ['1'], 'NaN']) assert.throws(() => videoContentLength(invalid));
  const server = createServer((req, res) => { req.resume(); req.on('end', () => res.end()); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/object`;
  try {
    await assert.rejects(streamQuarantineUpload(Readable.from([]), url), { code: 'MEDIA_EMPTY' });
    await assert.rejects(streamQuarantineUpload(Readable.from((function* () { for (let i = 0; i < 161; i++) yield Buffer.alloc(65536); })()), url), { code: 'MEDIA_SOURCE_TOO_LARGE' });
    await assert.rejects(streamQuarantineUpload(Readable.from([Buffer.alloc(2)]), url, 3), { code: 'MEDIA_LENGTH_MISMATCH' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('aborted inputs and storage failures fail rather than accepting partial media', async () => {
  const source = new Readable({ read() { this.push(Buffer.alloc(1024)); this.destroy(new Error('client gone')); } });
  const server = createServer((req, res) => { req.resume(); res.writeHead(503); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/object`;
  try {
    await assert.rejects(streamQuarantineUpload(source, url, 10000));
    await assert.rejects(streamQuarantineUpload(Readable.from([Buffer.alloc(1024)]), url, 1024), { code: 'MEDIA_STORAGE_UNAVAILABLE' });
    const closed = Readable.from([]); closed.destroy();
    await assert.rejects(streamQuarantineUpload(closed, url, 1), { code: 'MEDIA_UPLOAD_ABORTED' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('real MinIO accepts known-length and chunked bounded quarantine PUTs', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'void-media-minio-'));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn('/usr/local/bin/minio', ['server', root, '--address', `127.0.0.1:${port}`], {
    env: { ...process.env, MINIO_ROOT_USER: 'mediatest', MINIO_ROOT_PASSWORD: 'media-test-only-secret', MINIO_BROWSER: 'off' }, stdio: 'ignore',
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(`http://127.0.0.1:${port}/minio/health/ready`)).ok; } catch { /* Test service is starting. */ } if (ready) break; await delay(50); }
    assert.ok(ready, 'test MinIO did not start');
    const client = new Client({ endPoint: '127.0.0.1', port, useSSL: false, accessKey: 'mediatest', secretKey: 'media-test-only-secret', region: 'us-east-1' });
    await client.makeBucket('quarantine');
    for (const declared of [10485760, undefined]) {
      const key = declared ? 'known' : 'chunked';
      const url = await client.presignedPutObject('quarantine', key, 60);
      const source = Readable.from((function* () { for (let i = 0; i < 160; i++) yield Buffer.alloc(65536, 42); })());
      const bytes = await streamQuarantineUpload(source, url, declared).catch(error => { throw new Error(`${key}: ${JSON.stringify(error.cause)}`); });
      assert.equal(bytes, 10485760);
      assert.equal((await client.statObject('quarantine', key)).size, 10485760);
    }
  } finally { child.kill('SIGTERM'); await exited; await rm(root, { recursive: true, force: true }); }
});
