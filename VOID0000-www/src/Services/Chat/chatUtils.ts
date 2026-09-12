export const CHAT_API_PREFIX = '/api/conversations';
export const CHAT_FORWARDED_MESSAGE_TYPE = 'forwarded';

export function createApiError(data: unknown, meta?: Record<string, unknown>): Error & Record<string, unknown> {
  const payload = data && typeof data === 'object' ? data as Record<string, unknown> : null;
  const message =
    (typeof payload?.error === 'string' && payload.error.trim()) ||
    (typeof payload?.message === 'string' && payload.message.trim()) ||
    (typeof payload?.code === 'string' && payload.code.trim()) ||
    'Request failed';
  const error = new Error(message) as Error & Record<string, unknown>;
  if (data && typeof data === 'object') {
    Object.assign(error, data);
  }
  if (meta && typeof meta === 'object') {
    Object.assign(error, meta);
  }
  return error;
}

export function getRetryAfterMsFromResponse(response: Response): number | null {
  const retryAfter = response.headers.get('Retry-After');
  if (!retryAfter) {
    return null;
  }

  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }

  const retryAfterDate = Date.parse(retryAfter);
  if (Number.isFinite(retryAfterDate)) {
    return Math.max(0, retryAfterDate - Date.now());
  }

  return null;
}

export function getRetryAfterMsFromError(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const payload = error as Record<string, unknown>;
  if (payload.retryAfterMs !== null && payload.retryAfterMs !== undefined) {
    const retryAfterMs = Number(payload.retryAfterMs);
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
      return retryAfterMs;
    }
  }

  if (payload.retryAfterSeconds !== null && payload.retryAfterSeconds !== undefined) {
    const retryAfterSeconds = Number(payload.retryAfterSeconds);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return retryAfterSeconds * 1000;
    }
  }

  if (payload.resetTime !== null && payload.resetTime !== undefined) {
    const resetTime = Number(payload.resetTime);
    if (Number.isFinite(resetTime) && resetTime > 0) {
      return Math.max(0, resetTime - Date.now());
    }
  }

  return null;
}

export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const payload = error as Record<string, unknown>;
  return Number(payload.status ?? payload.statusCode) === 429 ||
    payload.code === 'RATE_LIMITED' ||
    payload.error === 'RATE_LIMITED';
}
