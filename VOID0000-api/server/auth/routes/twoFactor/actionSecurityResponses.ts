import type { Response } from 'express';
import {
  SecurityLimitExceededError,
} from '../../services/authAttemptLimitService.js';
import {
  SecurityCounterUnavailableError,
  type SecurityCounterState,
} from '../../services/securityCounterService.js';

export function sendSensitiveActionRateLimit(
  res: Response,
  state: SecurityCounterState,
) {
  const retryAfterSeconds = Math.max(1, state.retryAfterSeconds || 1);
  res.set('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({
    success: false,
    message: 'Too many incorrect password attempts. Please wait before trying again.',
    code: 'TWO_FA_ACTION_RATE_LIMIT',
    retryAfterSeconds,
  });
}

export function handleSensitiveActionSecurityError(res: Response, error: unknown) {
  if (error instanceof SecurityLimitExceededError) {
    return sendSensitiveActionRateLimit(res, error.state);
  }
  if (error instanceof SecurityCounterUnavailableError) {
    return res.status(503).json({
      success: false,
      message: 'Security verification is temporarily unavailable. Please try again.',
      code: 'TWO_FA_ACTION_SECURITY_UNAVAILABLE',
      retryable: true,
    });
  }
  return null;
}
