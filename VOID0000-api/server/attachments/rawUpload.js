import { MAX_CHAT_ATTACHMENT_BYTES } from '../utils/chatImageLimits.js';

export const ATTACHMENT_RAW_UPLOAD_LIMITS = Object.freeze({
  maxFileBytes: MAX_CHAT_ATTACHMENT_BYTES,
  maxFilenameHeaderBytes: 2048,
  maxFilenameCharacters: 255,
  maxMimeHeaderBytes: 255,
  maxBlurhashHeaderBytes: 256,
  maxDimension: 100_000,
});

export class AttachmentRawUploadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AttachmentRawUploadError';
    this.status = status;
    this.code = code;
    this.body = { error: message, code };
  }
}

function rawUploadError(status, code, message) {
  return new AttachmentRawUploadError(status, code, message);
}

function resolveLimits(overrides = {}) {
  const resolved = {
    ...ATTACHMENT_RAW_UPLOAD_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Invalid raw attachment limit: ${name}`);
    }
  }
  return resolved;
}

function readHeader(request, name, maximumBytes) {
  const value = request.headers?.[name];
  if (value === undefined) {
    return '';
  }
  if (Array.isArray(value) || typeof value !== 'string') {
    throw rawUploadError(
      400,
      'ATTACHMENT_METADATA_INVALID',
      `Attachment ${name} header is invalid`,
    );
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw rawUploadError(
      413,
      'ATTACHMENT_METADATA_TOO_LARGE',
      'Attachment metadata is too large',
    );
  }
  return value;
}

function readFilename(request, limits) {
  const encoded = readHeader(
    request,
    'x-attachment-filename',
    limits.maxFilenameHeaderBytes,
  );
  if (!encoded) {
    return undefined;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw rawUploadError(
      400,
      'ATTACHMENT_METADATA_INVALID',
      'Attachment filename metadata is malformed',
    );
  }

  if (
    decoded.length === 0 ||
    decoded.length > limits.maxFilenameCharacters ||
    /[\u0000-\u001f\u007f]/.test(decoded)
  ) {
    throw rawUploadError(
      400,
      'ATTACHMENT_METADATA_INVALID',
      'Attachment filename metadata is invalid',
    );
  }
  return decoded;
}

function readClaimedMime(request, limits) {
  const value = readHeader(
    request,
    'x-attachment-mime',
    limits.maxMimeHeaderBytes,
  ).trim();
  if (!value) {
    return 'application/octet-stream';
  }
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw rawUploadError(
      400,
      'ATTACHMENT_METADATA_INVALID',
      'Attachment MIME metadata is invalid',
    );
  }
  return value;
}

function readOptionalPositiveInteger(request, name, maximum) {
  const value = readHeader(request, name, 16).trim();
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw rawUploadError(
      400,
      'ATTACHMENT_METADATA_INVALID',
      `Attachment ${name} header is invalid`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw rawUploadError(
      400,
      'ATTACHMENT_METADATA_INVALID',
      `Attachment ${name} header is invalid`,
    );
  }
  return parsed;
}

function readBlurhash(request, limits) {
  const value = readHeader(
    request,
    'x-attachment-blurhash',
    limits.maxBlurhashHeaderBytes,
  );
  if (!value) {
    return undefined;
  }
  if (!/^[\x20-\x7e]+$/.test(value)) {
    throw rawUploadError(
      400,
      'ATTACHMENT_METADATA_INVALID',
      'Attachment BlurHash metadata is invalid',
    );
  }
  return value;
}

function readContentLength(request) {
  const value = request.headers?.['content-length'];
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value) || typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw rawUploadError(
      400,
      'ATTACHMENT_LENGTH_INVALID',
      'Attachment Content-Length is invalid',
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw rawUploadError(
      400,
      'ATTACHMENT_LENGTH_INVALID',
      'Attachment Content-Length is invalid',
    );
  }
  return parsed;
}

function assertBinaryContentType(request) {
  const rawContentType = request.headers?.['content-type'];
  const contentType = typeof rawContentType === 'string'
    ? rawContentType.split(';', 1)[0].trim().toLowerCase()
    : '';
  if (contentType !== 'application/octet-stream') {
    request.resume();
    throw rawUploadError(
      415,
      'ATTACHMENT_BINARY_CONTENT_TYPE_REQUIRED',
      'Attachment uploads require application/octet-stream',
    );
  }
}

export async function parseAttachmentRawRequest(request, options = {}) {
  const limits = resolveLimits(options.limits);
  assertBinaryContentType(request);

  let contentLength;
  try {
    contentLength = readContentLength(request);
  } catch (error) {
    request.resume();
    throw error;
  }
  if (contentLength !== null && contentLength > limits.maxFileBytes) {
    request.resume();
    throw rawUploadError(
      413,
      'ATTACHMENT_TOO_LARGE',
      'File too large. Maximum 10MB per attachment.',
    );
  }
  if (request.readableEnded) {
    throw rawUploadError(
      400,
      'ATTACHMENT_BODY_UNAVAILABLE',
      'Attachment binary body is unavailable',
    );
  }

  let metadata;
  try {
    metadata = {
      name: readFilename(request, limits),
      mime: readClaimedMime(request, limits),
      width: readOptionalPositiveInteger(
        request,
        'x-attachment-width',
        limits.maxDimension,
      ),
      height: readOptionalPositiveInteger(
        request,
        'x-attachment-height',
        limits.maxDimension,
      ),
      blurhash: readBlurhash(request, limits),
    };
  } catch (error) {
    request.resume();
    throw error;
  }

  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.removeListener('aborted', onAborted);
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
    };

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.resume();
      reject(error);
    };

    const onAborted = () => rejectOnce(rawUploadError(
      400,
      'ATTACHMENT_UPLOAD_ABORTED',
      'Attachment upload was interrupted',
    ));
    const onError = () => rejectOnce(rawUploadError(
      400,
      'ATTACHMENT_UPLOAD_INVALID',
      'Attachment upload stream is invalid',
    ));
    const onData = (chunk) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bufferChunk.length;
      if (totalBytes > limits.maxFileBytes) {
        rejectOnce(rawUploadError(
          413,
          'ATTACHMENT_TOO_LARGE',
          'File too large. Maximum 10MB per attachment.',
        ));
        return;
      }
      chunks.push(bufferChunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();

      if (totalBytes === 0) {
        reject(rawUploadError(
          400,
          'ATTACHMENT_EMPTY',
          'Attachment payload was empty',
        ));
        return;
      }
      if (contentLength !== null && contentLength !== totalBytes) {
        reject(rawUploadError(
          400,
          'ATTACHMENT_LENGTH_MISMATCH',
          'Attachment Content-Length did not match the received bytes',
        ));
        return;
      }
      resolve(Buffer.concat(chunks, totalBytes));
    };

    request.once('aborted', onAborted);
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
  });

  metadata.size = buffer.length;
  return {
    file: {
      buffer,
      clientFilename: metadata.name || '',
      clientMimeType: metadata.mime,
      metadata,
    },
  };
}
