export const REFRESH_ROTATION_RETRY_AFTER_MS = 250;

export function classifyRefreshTokenMiss(hasActiveDeviceToken) {
  if (hasActiveDeviceToken) {
    return {
      kind: 'rotated',
      status: 409,
      body: {
        success: false,
        code: 'REFRESH_TOKEN_ROTATED',
        message: 'Refresh token was already rotated. Retry with the current session cookie.',
        retryAfterMs: REFRESH_ROTATION_RETRY_AFTER_MS,
      },
    };
  }

  return {
    kind: 'invalid',
    status: 403,
    body: {
      success: false,
      code: 'REFRESH_TOKEN_INVALID',
      message: 'Session expired. Please login again.',
    },
  };
}
