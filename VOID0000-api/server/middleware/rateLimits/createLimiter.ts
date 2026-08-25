import { RATE_LIMIT_ALGORITHMS } from './algorithms.js';
import { createAuthLockoutLimiter } from './authLockoutLimiter.js';
import { createTokenBucketLimiter } from './tokenBucketLimiter.js';
import type { RequestHandler } from 'express';
import type { RateLimitPolicy } from './types.js';

export function createConfiguredLimiter(policy: RateLimitPolicy): RequestHandler {
  const algorithm = policy.algorithm ?? RATE_LIMIT_ALGORITHMS.TOKEN_BUCKET;

  switch (algorithm) {
    case RATE_LIMIT_ALGORITHMS.AUTH_LOCKOUT:
    case RATE_LIMIT_ALGORITHMS.MULTI_BUCKET:
      return createAuthLockoutLimiter(policy);
    case RATE_LIMIT_ALGORITHMS.TOKEN_BUCKET:
      return createTokenBucketLimiter(policy);
    default:
      throw new Error(`Unsupported rate limit algorithm: ${algorithm}`);
  }
}
