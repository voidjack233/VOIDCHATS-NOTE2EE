import assert from 'node:assert/strict';
import test from 'node:test';
import { getErrorMessage } from '../../../src/Services/utils/errorMessage';
import { createApiError, getRetryAfterMsFromError, isRateLimitError } from '../../../src/Services/Chat/chatUtils';

test('error display preserves Error and plain API rejection messages without trimming', () => {
  assert.equal(getErrorMessage(new Error('Network failed'), 'fallback'), 'Network failed');
  assert.equal(getErrorMessage({ message: '  API rejected  ', code: 'DENIED' }, 'fallback'), '  API rejected  ');
  assert.equal(getErrorMessage(new TypeError('Failed to fetch'), 'fallback'), 'Failed to fetch');
});

test('error display falls back for unknown or missing messages', () => {
  for (const error of [null, undefined, false, 0, 'failure', {}, { message: '' }, { message: 42 }]) {
    assert.equal(getErrorMessage(error, 'fallback'), 'fallback');
  }
});

test('API errors preserve payload fields and metadata precedence for retry handling', () => {
  const error = createApiError(
    { error: '  Slow down  ', code: 'RATE_LIMITED', retryAfterSeconds: 5, status: 400 },
    { status: 429, retryAfterMs: 250 },
  );
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'Slow down');
  assert.equal(error.error, '  Slow down  ');
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterSeconds, 5);
  assert.equal(getRetryAfterMsFromError(error), 250);
  assert.equal(isRateLimitError(error), true);
});

test('API error construction retains existing Object.assign message precedence', () => {
  assert.equal(createApiError({ error: 'First', message: '  Original  ' }).message, '  Original  ');
  assert.equal(createApiError({ message: 'Original' }, { message: 'Override' }).message, 'Override');
  assert.equal(createApiError({ code: '  REQUEST_TIMEOUT  ' }).message, 'REQUEST_TIMEOUT');
  for (const payload of [null, undefined, 0, 'failure', {}]) {
    assert.equal(createApiError(payload).message, 'Request failed');
  }
});
