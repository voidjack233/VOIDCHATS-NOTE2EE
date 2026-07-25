import {
  SecurityLimitExceededError,
} from '../../services/authAttemptLimitService.js';
import {
  SecurityCounterUnavailableError,
} from '../../services/securityCounterService.js';

export function sendSensitiveActionRateLimit(res, state) {
  const retryAfterSeconds = Math.max(1, state.retryAfterSeconds || 1);
  res.set('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({
    success: false,
    message: 'Too many incorrect password attempts. Please wait before trying again.',
    code: 'TWO_FA_ACTION_RATE_LIMIT',
    retryAfterSeconds,
  });
}

export function handleSensitiveActionSecurityError(res, error) {
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
