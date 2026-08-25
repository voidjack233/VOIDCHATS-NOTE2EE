export type RateLimitAlgorithm = 'auth_lockout' | 'multi_bucket' | 'token_bucket';
export type RateLimitScope = 'device' | 'ip' | 'subject' | 'user';

export interface RateLimitDimension {
  scope: RateLimitScope;
  refillWindowSec: number;
  bucketSize: number;
  blockSeconds?: readonly number[];
}

export interface RateLimitPolicy {
  algorithm?: RateLimitAlgorithm;
  keyPrefix?: string;
  prefix?: string;
  scope?: RateLimitScope;
  refillWindowSec?: number;
  windowSec?: number;
  bucketSize?: number;
  maxAttempts?: number;
  blockSeconds?: readonly number[];
  escalatingBlocks?: readonly number[];
  dimensions?: readonly RateLimitDimension[];
  subjectFields?: readonly string[];
  logAction?: string | null;
  message?: string;
  code?: string;
}

export interface TokenBucketOptions {
  key: string;
  refillWindowSec: number;
  bucketSize: number;
  blockSeconds: readonly number[];
}

export interface TokenBucketResult {
  allowed: boolean;
  retrySeconds: number;
  resetTime: number;
  limitHits: number;
}
