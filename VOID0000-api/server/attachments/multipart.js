import { Transform } from 'node:stream';
import Busboy from 'busboy';

import { MAX_CHAT_ATTACHMENT_BYTES } from '../utils/chatImageLimits.js';

export const ATTACHMENT_MULTIPART_LIMITS = Object.freeze({
  maxFiles: 5,
  maxFileBytes: MAX_CHAT_ATTACHMENT_BYTES,
  maxMetadataBytes: 16 * 1024,
  maxTotalBytes: (5 * MAX_CHAT_ATTACHMENT_BYTES) + (256 * 1024),
  maxFieldNameBytes: 32,
  maxHeaderPairs: 50,
});

const MAX_METADATA_NAME_LENGTH = 255;
const MAX_METADATA_MIME_LENGTH = 255;
const MAX_METADATA_BLURHASH_LENGTH = 256;
const MAX_METADATA_DIMENSION = 100_000;

export class AttachmentMultipartError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AttachmentMultipartError';
    this.status = status;
    this.code = code;
    this.body = { error: message, code };
  }
}

function multipartError(status, code, message) {
  return new AttachmentMultipartError(status, code, message);
}

function resolveLimits(overrides = {}) {
  const resolved = {
    ...ATTACHMENT_MULTIPART_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Invalid multipart limit: ${name}`);
    }
  }
  return resolved;
}

function readOptionalString(value, name, maximumLength) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw multipartError(
      400,
      'ATTACHMENT_METADATA_INVALID',
      `Attachment metadata ${name} is invalid`,
    );
  }
  return value;
}

function readOptionalNumber(value, name, { maximum, allowZero = false }) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > maximum
  ) {
    throw multipartError(
      400,
      'ATTACHMENT_METADATA_INVALID',
      `Attachment metadata ${name} is invalid`,
    );
  }
  return value;
}

function parseMetadata(rawMetadata, fileCount, limits) {
  if (rawMetadata === null) {
    throw multipartError(
      400,
      'ATTACHMENT_METADATA_REQUIRED',
      'Attachment metadata field is required',
    );
  }
  if (Buffer.byteLength(rawMetadata, 'utf8') > limits.maxMetadataBytes) {
    throw multipartError(
      413,
      'ATTACHMENT_METADATA_TOO_LARGE',
      'Attachment metadata is too large',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawMetadata);
  } catch {
    throw multipartError(
      400,
      'ATTACHMENT_METADATA_INVALID',
      'Attachment metadata is malformed',
    );
  }

  if (!Array.isArray(parsed) || parsed.length !== fileCount) {
    throw multipartError(
      400,
      'ATTACHMENT_METADATA_INVALID',
      'Attachment metadata must match the uploaded files',
    );
  }

  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw multipartError(
        400,
        'ATTACHMENT_METADATA_INVALID',
        'Each attachment metadata entry must be an object',
      );
    }

    return {
      name: readOptionalString(entry.name, 'name', MAX_METADATA_NAME_LENGTH),
      mime: readOptionalString(entry.mime, 'MIME type', MAX_METADATA_MIME_LENGTH),
      size: readOptionalNumber(entry.size, 'size', {
        maximum: limits.maxFileBytes,
        allowZero: true,
      }),
      width: readOptionalNumber(entry.width, 'width', {
        maximum: MAX_METADATA_DIMENSION,
      }),
      height: readOptionalNumber(entry.height, 'height', {
        maximum: MAX_METADATA_DIMENSION,
      }),
      blurhash: readOptionalString(
        entry.blurhash,
        'blurhash',
        MAX_METADATA_BLURHASH_LENGTH,
      ),
    };
  });
}

function getContentLength(headers) {
  const rawValue = headers?.['content-length'];
  const normalized = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  if (typeof normalized !== 'string' || !/^\d+$/.test(normalized.trim())) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function parseAttachmentMultipartRequest(request, options = {}) {
  const limits = resolveLimits(options.limits);
  const contentLength = getContentLength(request.headers);
  if (contentLength !== null && contentLength > limits.maxTotalBytes) {
    request.resume();
    throw multipartError(
      413,
      'ATTACHMENT_REQUEST_TOO_LARGE',
      'Attachment upload request is too large',
    );
  }

  let parser;
  try {
    parser = Busboy({
      headers: request.headers,
      limits: {
        fieldNameSize: limits.maxFieldNameBytes,
        fieldSize: limits.maxMetadataBytes,
        fields: 1,
        fileSize: limits.maxFileBytes,
        files: limits.maxFiles,
        // Busboy emits partsLimit when the configured count is reached, so
        // leave one sentinel slot while files/fields enforce the real limits.
        parts: limits.maxFiles + 2,
        headerPairs: limits.maxHeaderPairs,
      },
    });
  } catch {
    request.resume();
    throw multipartError(
      400,
      'ATTACHMENT_MULTIPART_INVALID',
      'A valid multipart/form-data attachment request is required',
    );
  }

  return new Promise((resolve, reject) => {
    const files = [];
    let metadataRaw = null;
    let metadataSeen = false;
    let parseFailure = null;
    let settled = false;
    let totalBytes = 0;

    const rememberFailure = (error) => {
      if (!parseFailure) {
        parseFailure = error;
      }
    };

    const stopPipeline = () => {
      request.unpipe(byteLimiter);
      byteLimiter.unpipe(parser);
      if (!byteLimiter.destroyed) byteLimiter.destroy();
      if (!parser.destroyed) parser.destroy();
      if (!request.destroyed) request.resume();
    };

    const rejectNow = (error) => {
      if (settled) return;
      settled = true;
      stopPipeline();
      reject(error instanceof AttachmentMultipartError
        ? error
        : multipartError(
            400,
            'ATTACHMENT_MULTIPART_INVALID',
            'Attachment multipart payload is malformed',
          ));
    };

    const byteLimiter = new Transform({
      transform(chunk, _encoding, callback) {
        totalBytes += chunk.length;
        if (totalBytes > limits.maxTotalBytes) {
          callback(multipartError(
            413,
            'ATTACHMENT_REQUEST_TOO_LARGE',
            'Attachment upload request is too large',
          ));
          return;
        }
        callback(null, chunk);
      },
    });

    byteLimiter.once('error', rejectNow);
    request.once('aborted', () => rejectNow(multipartError(
      400,
      'ATTACHMENT_MULTIPART_ABORTED',
      'Attachment upload was interrupted',
    )));
    request.once('error', rejectNow);
    parser.once('error', rejectNow);

    parser.on('file', (fieldName, stream, info) => {
      if (fieldName !== 'files') {
        rememberFailure(multipartError(
          400,
          'ATTACHMENT_FILE_FIELD_INVALID',
          'Unexpected attachment file field',
        ));
        stream.resume();
        return;
      }

      const entry = {
        buffer: null,
        clientFilename: typeof info.filename === 'string' ? info.filename : '',
        clientMimeType: typeof info.mimeType === 'string' ? info.mimeType : '',
        metadata: null,
      };
      files.push(entry);
      const chunks = [];
      let fileBytes = 0;

      stream.on('limit', () => {
        rememberFailure(multipartError(
          413,
          'ATTACHMENT_TOO_LARGE',
          'File too large. Maximum 10MB per attachment.',
        ));
      });
      stream.on('data', (chunk) => {
        fileBytes += chunk.length;
        if (!parseFailure && fileBytes <= limits.maxFileBytes) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      });
      stream.once('error', () => {
        rememberFailure(multipartError(
          400,
          'ATTACHMENT_MULTIPART_INVALID',
          'Attachment file stream is malformed',
        ));
      });
      stream.once('end', () => {
        if (stream.truncated || fileBytes > limits.maxFileBytes) {
          rememberFailure(multipartError(
            413,
            'ATTACHMENT_TOO_LARGE',
            'File too large. Maximum 10MB per attachment.',
          ));
          return;
        }
        if (fileBytes === 0) {
          rememberFailure(multipartError(
            400,
            'ATTACHMENT_EMPTY',
            'Attachment payload was empty',
          ));
          return;
        }
        entry.buffer = Buffer.concat(chunks, fileBytes);
      });
    });

    parser.on('field', (fieldName, value, info) => {
      if (fieldName !== 'metadata') {
        rememberFailure(multipartError(
          400,
          'ATTACHMENT_FIELD_INVALID',
          'Unexpected attachment metadata field',
        ));
        return;
      }
      if (metadataSeen) {
        rememberFailure(multipartError(
          400,
          'ATTACHMENT_METADATA_INVALID',
          'Attachment metadata field must appear once',
        ));
        return;
      }
      metadataSeen = true;
      if (info.valueTruncated) {
        rememberFailure(multipartError(
          413,
          'ATTACHMENT_METADATA_TOO_LARGE',
          'Attachment metadata is too large',
        ));
        return;
      }
      metadataRaw = value;
    });

    parser.once('filesLimit', () => {
      rememberFailure(multipartError(
        400,
        'ATTACHMENT_FILE_LIMIT_EXCEEDED',
        `Maximum ${limits.maxFiles} files per message`,
      ));
    });
    parser.once('fieldsLimit', () => {
      rememberFailure(multipartError(
        400,
        'ATTACHMENT_FIELD_LIMIT_EXCEEDED',
        'Too many attachment metadata fields',
      ));
    });
    parser.once('partsLimit', () => {
      rememberFailure(multipartError(
        400,
        'ATTACHMENT_PART_LIMIT_EXCEEDED',
        'Too many multipart attachment parts',
      ));
    });

    parser.once('close', () => {
      if (settled) return;
      if (parseFailure) {
        settled = true;
        reject(parseFailure);
        return;
      }
      if (files.length === 0) {
        settled = true;
        reject(multipartError(
          400,
          'ATTACHMENT_FILES_REQUIRED',
          'At least one attachment file is required',
        ));
        return;
      }
      if (files.some((file) => !Buffer.isBuffer(file.buffer))) {
        settled = true;
        reject(multipartError(
          400,
          'ATTACHMENT_MULTIPART_INVALID',
          'Attachment file was incomplete',
        ));
        return;
      }

      let metadata;
      try {
        metadata = parseMetadata(metadataRaw, files.length, limits);
      } catch (error) {
        settled = true;
        reject(error);
        return;
      }

      metadata.forEach((entry, index) => {
        files[index].metadata = entry;
      });
      settled = true;
      resolve({ files });
    });

    request.pipe(byteLimiter).pipe(parser);
  });
}
