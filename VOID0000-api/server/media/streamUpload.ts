import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Transform, type Readable } from 'node:stream';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VIDEO_SOURCE_MAX_BYTES } from './protocol.js';

export class VideoUploadError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export function videoContentLength(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new VideoUploadError(400, 'MEDIA_LENGTH_INVALID');
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size > VIDEO_SOURCE_MAX_BYTES) throw new VideoUploadError(413, 'MEDIA_SOURCE_TOO_LARGE');
  if (size === 0) throw new VideoUploadError(400, 'MEDIA_EMPTY');
  return size;
}

// The MinIO SDK's putObject buffers files below its multipart threshold. Use a
// private presigned PUT and Node's backpressured HTTP stream instead. No redirects.
let spoolCount = 0;
async function spoolUnknown(source: Readable, url: string): Promise<number> {
  if (spoolCount >= 2) throw new VideoUploadError(429, 'MEDIA_UPLOAD_BUSY');
  spoolCount++;
  let directory = '';
  try {
    const prefix = `void-media-upload-${process.getuid?.() || 0}-`;
    // Files left by a killed process cannot be active after the 60s upload bound.
    for (const name of (await readdir(tmpdir())).filter(name => name.startsWith(prefix)).slice(0, 20)) {
      const path = join(tmpdir(), name);
      const info = await lstat(path).catch(() => null);
      if (info?.isDirectory() && info.uid === process.getuid?.() && Date.now() - info.mtimeMs > 3600_000) await rm(path, { recursive: true, force: true });
    }
    directory = await mkdtemp(join(tmpdir(), prefix));
    const path = join(directory, 'source');
    const bytes = await new Promise<number>((resolve, reject) => {
      let count = 0;
      let settled = false;
      const writer = createWriteStream(path, { flags: 'wx', mode: 0o600, highWaterMark: 65536 });
      const counter = new Transform({ highWaterMark: 65536, transform(chunk: Buffer, _enc, done) {
        count += chunk.length;
        done(count > VIDEO_SOURCE_MAX_BYTES ? new VideoUploadError(413, 'MEDIA_SOURCE_TOO_LARGE') : null, chunk);
      } });
      const abort = () => finish(new VideoUploadError(400, 'MEDIA_UPLOAD_ABORTED'));
      const timer = setTimeout(() => finish(new VideoUploadError(408, 'MEDIA_UPLOAD_TIMEOUT')), 60000);
      function finish(error?: Error) {
        if (settled) return; settled = true; clearTimeout(timer);
        source.unpipe(counter); source.removeListener('aborted', abort); source.removeListener('error', abort);
        counter.destroy(); writer.destroy();
        if (error) { source.resume(); reject(error); } else if (!count) reject(new VideoUploadError(400, 'MEDIA_EMPTY')); else resolve(count);
      }
      source.once('aborted', abort); source.once('error', abort);
      counter.once('error', finish); writer.once('error', finish); writer.once('finish', () => finish());
      source.pipe(counter).pipe(writer);
    });
    const stream = createReadStream(path, { highWaterMark: 65536 });
    try { return await streamQuarantineUpload(stream, url, bytes); } finally { stream.destroy(); }
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { spoolCount--; }
  }
}

export function streamQuarantineUpload(source: Readable, signedPutUrl: string, declaredSize?: number): Promise<number> {
  if (source.destroyed || source.readableAborted) return Promise.reject(new VideoUploadError(400, 'MEDIA_UPLOAD_ABORTED'));
  if (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > VIDEO_SOURCE_MAX_BYTES)) {
    return Promise.reject(new VideoUploadError(413, 'MEDIA_SOURCE_TOO_LARGE'));
  }
  // MinIO rejects unsigned chunked PUT (411). Unknown-length clients are spooled
  // to private, byte/time/concurrency-bounded disk, never an in-memory SDK buffer.
  if (declaredSize === undefined) return spoolUnknown(source, signedPutUrl);
  return new Promise((resolve, reject) => {
    let count = 0;
    let settled = false;
    const target = new URL(signedPutUrl);
    if (!['http:', 'https:'].includes(target.protocol)) { reject(new VideoUploadError(503, 'MEDIA_STORAGE_UNAVAILABLE')); return; }
    const limiter = new Transform({ highWaterMark: 64 * 1024, transform(chunk: Buffer, _encoding, done) {
      count += chunk.length;
      if (count > VIDEO_SOURCE_MAX_BYTES) { done(new VideoUploadError(413, 'MEDIA_SOURCE_TOO_LARGE')); return; }
      if (count > declaredSize) { done(new VideoUploadError(400, 'MEDIA_LENGTH_MISMATCH')); return; }
      done(null, chunk);
    }, flush(done) {
      if (!count) done(new VideoUploadError(400, 'MEDIA_EMPTY'));
      else if (declaredSize !== undefined && count !== declaredSize) done(new VideoUploadError(400, 'MEDIA_LENGTH_MISMATCH'));
      else done();
    } });
    const outgoing = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...(declaredSize === undefined ? {} : { 'Content-Length': declaredSize }) },
    });
    const timer = setTimeout(() => finish(new VideoUploadError(408, 'MEDIA_UPLOAD_TIMEOUT')), 60_000);
    const aborted = () => finish(new VideoUploadError(400, 'MEDIA_UPLOAD_ABORTED'));
    const sourceError = () => finish(new VideoUploadError(400, 'MEDIA_UPLOAD_ABORTED'));
    function finish(error?: Error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      source.unpipe(limiter); limiter.unpipe(outgoing);
      source.removeListener('aborted', aborted); source.removeListener('error', sourceError);
      if (error) { limiter.destroy(); outgoing.destroy(); source.resume(); reject(error); }
      else resolve(count);
    }
    source.once('aborted', aborted); source.once('error', sourceError);
    limiter.once('error', error => finish(error));
    outgoing.once('error', () => finish(new VideoUploadError(503, 'MEDIA_STORAGE_UNAVAILABLE')));
    outgoing.once('response', response => {
      response.resume();
      response.once('error', () => finish(new VideoUploadError(503, 'MEDIA_STORAGE_UNAVAILABLE')));
      response.once('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          const error = new VideoUploadError(503, 'MEDIA_STORAGE_UNAVAILABLE');
          error.cause = { storageStatus: response.statusCode };
          finish(error);
        }
        else if (!limiter.writableFinished || !count) finish(new VideoUploadError(400, 'MEDIA_UPLOAD_INVALID'));
        else finish();
      });
    });
    source.pipe(limiter).pipe(outgoing);
  });
}
