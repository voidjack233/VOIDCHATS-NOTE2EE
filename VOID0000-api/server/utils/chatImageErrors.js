export class ChatImageSanitizationError extends Error {
  constructor(message, { code, status }) {
    super(message);
    this.name = 'ChatImageSanitizationError';
    this.code = code;
    this.status = status;
  }
}

export class AttachmentSanitizerTransportError extends Error {
  constructor(message, { code, status, retryable = true }) {
    super(message);
    this.name = 'AttachmentSanitizerTransportError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
