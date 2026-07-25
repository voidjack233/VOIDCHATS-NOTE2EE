import { Router } from 'express';
import { pool } from '../../db.js';
import { hashToken } from '../services/tokenService.js';
import { verifyEmailVerificationCode } from '../../utils/emailVerificationSecurity.js';
import {
  SecurityLimitExceededError,
  assertEmailVerificationAllowed,
  clearEmailVerificationFailures,
  recordEmailVerificationFailure,
} from '../services/authAttemptLimitService.js';
import {
  SecurityCounterUnavailableError,
} from '../services/securityCounterService.js';

const router = Router();

function sendVerificationRateLimit(res, state) {
  const retryAfterSeconds = Math.max(1, state.retryAfterSeconds || 1);
  res.set('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({
    success: false,
    message: 'Too many verification attempts. Please wait before trying again.',
    code: 'EMAIL_VERIFICATION_RATE_LIMIT',
    retryAfterSeconds,
    retryAfterMs: retryAfterSeconds * 1000,
  });
}

function handleVerificationSecurityError(res, error) {
  if (error instanceof SecurityLimitExceededError) {
    return sendVerificationRateLimit(res, error.state);
  }
  if (error instanceof SecurityCounterUnavailableError) {
    return res.status(503).json({
      success: false,
      message: 'Email verification is temporarily unavailable. Please try again.',
      code: 'EMAIL_VERIFICATION_SECURITY_UNAVAILABLE',
      retryable: true,
    });
  }
  return null;
}

router.post('/', async (req, res) => {
  const { code, token } = req.body;

  if (
    typeof code !== 'string' ||
    typeof token !== 'string' ||
    !code ||
    !token ||
    code.length > 128 ||
    token.length > 1024
  ) {
    return res.status(400).json({
      success: false,
      message: 'Code and token are required'
    });
  }

  const tokenHash = hashToken(token);
  try {
    await assertEmailVerificationAllowed({ req, tokenHash });
  } catch (error) {
    const securityResponse = handleVerificationSecurityError(res, error);
    if (securityResponse) return securityResponse;
    throw error;
  }

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const result = await client.query(
      `SELECT user_id, expires_at, code
       FROM email_verifications
       WHERE token = $1
       FOR UPDATE`,
      [tokenHash]
    );

    const record = result.rows[0];
    if (record) {
      await assertEmailVerificationAllowed({
        req,
        tokenHash,
        userId: record.user_id,
      });
    }

    const validRecord = Boolean(
      record &&
      code.length === 6 &&
      new Date() <= new Date(record.expires_at) &&
      verifyEmailVerificationCode(record.user_id, code, record.code),
    );

    if (!validRecord) {
      const failureState = await recordEmailVerificationFailure({
        req,
        tokenHash,
        userId: record?.user_id,
      });
      await client.query('ROLLBACK');
      transactionOpen = false;
      if (failureState.exhausted) {
        return sendVerificationRateLimit(res, failureState);
      }
      return res.status(400).json({
        success: false,
        message: 'Invalid token or verification code'
      });
    }

    await client.query(
      'UPDATE users SET is_verified = true WHERE id = $1',
      [record.user_id]
    );

    await client.query(
      'DELETE FROM email_verifications WHERE user_id = $1',
      [record.user_id]
    );

    await client.query('COMMIT');
    transactionOpen = false;

    try {
      await clearEmailVerificationFailures({
        req,
        tokenHash,
        userId: record.user_id,
      });
    } catch (error) {
      console.error('Email verification counter cleanup failed:', error);
    }

    return res.json({
      success: true,
      message: 'Email verified successfully'
    });
  } catch (err) {
    if (transactionOpen) {
      await client.query('ROLLBACK');
    }
    const securityResponse = handleVerificationSecurityError(res, err);
    if (securityResponse) return securityResponse;
    console.error('Verification error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error during verification'
    });
  } finally {
    client.release();
  }
});

export default router;
