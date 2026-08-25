export class ChatImageSanitizationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    message: string,
    { code, status }: { code: string; status: number },
  ) {
    super(message);
    this.name = 'ChatImageSanitizationError';
    this.code = code;
    this.status = status;
  }
}

export class AttachmentSanitizerTransportError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    {
      code,
      status,
      retryable = true,
    }: { code: string; status: number; retryable?: boolean },
  ) {
    super(message);
    this.name = 'AttachmentSanitizerTransportError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
