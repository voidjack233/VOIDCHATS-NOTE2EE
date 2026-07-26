import { Router } from 'express';
import { pool } from '../../../db.js';
import { totp } from '../../services/totpService.js';
import { sendVerificationEmail } from '../../../middleware/emailService.js';
import { updateTrustScore } from '../../../middleware/captcha/trustScore.js';
import { DeviceFingerprint } from '../../../utils/deviceFingerprint.js';
import { IPSecurity } from '../../../utils/securityUtils.js';
import {
  consumeBackupCode,
  decrypt,
  findMatchingBackupCodeId,
  safeEqualHex,
} from '../../services/twoFactorService.js';
import {
  checkTwoFactorBlocked,
  claimVerifiedTwoFactorSession,
  clearTwoFactorAttemptState,
  create2FASession,
  deletePendingTwoFactorSession,
  generateEmailCode,
  getPendingTwoFactorSession,
  getTwoFactorEmailRetryAfter,
  hasExceededTwoFactorEmailSends,
  hashEmailCode,
  isSameRequestBinding,
  recordTwoFactorEmailSend,
  recordTwoFactorFailure,
  updatePendingTwoFactorSession,
} from '../../services/twoFactorChallengeService.js';
import {
  isTwoFactorMethodAuthorized,
  normalizeTwoFactorMethod,
} from '../../services/twoFactorMethodService.js';
import {
  SecurityCounterUnavailableError,
} from '../../services/securityCounterService.js';
import {
  activateLoginSession,
  createLoginSessionRecord,
  setLoginSessionCookies,
} from '../../services/loginSessionService.js';

const router = Router();

export { create2FASession };

function sendTwoFactorCounterUnavailable(res) {
  return res.status(503).json({
    success: false,
    message: 'Verification is temporarily unavailable. Please try again.',
    code: 'TWO_FA_SECURITY_UNAVAILABLE',
    retryable: true,
  });
}

async function sendFailedTwoFactorAttempt(res, twoFactorToken, message) {
  const failureState = await recordTwoFactorFailure(twoFactorToken);
  if (failureState.exhausted) {
    await deletePendingTwoFactorSession(twoFactorToken);
    res.set('Retry-After', String(Math.max(1, failureState.retryAfterSeconds)));
    return res.status(429).json({
      success: false,
      message: 'Too many invalid 2FA attempts. Please login again.',
      code: 'TWO_FA_RATE_LIMIT',
      retryAfterSeconds: failureState.retryAfterSeconds,
    });
  }

  return res.status(400).json({
    success: false,
    message,
  });
}

// POST /api/auth/2fa/verify-login/send-email — Send email code during login
router.post('/send-email', async (req, res) => {
  try {
    const { twoFactorToken } = req.body;

    if (!twoFactorToken) {
      return res.status(400).json({ success: false, message: 'Invalid session' });
    }

    const session = await getPendingTwoFactorSession(twoFactorToken);
    if (!session || Date.now() > session.expiresAt) {
      await clearTwoFactorAttemptState(twoFactorToken);
      return res.status(401).json({ success: false, message: 'Session expired. Please login again.' });
    }

    if (!isSameRequestBinding(session, req)) {
      await clearTwoFactorAttemptState(twoFactorToken);
      return res.status(401).json({
        success: false,
        message: '2FA session changed devices. Please login again.',
        code: 'TWO_FA_DEVICE_MISMATCH',
      });
    }

    if (
      !await isTwoFactorMethodAuthorized(pool, session, 'email')
    ) {
      return res.status(400).json({
        success: false,
        message: 'The selected verification method is unavailable.',
        code: 'TWO_FA_METHOD_UNAVAILABLE',
      });
    }

    const emailSendCount = await recordTwoFactorEmailSend(twoFactorToken);
    if (hasExceededTwoFactorEmailSends(emailSendCount)) {
      const retryAfterSeconds = await getTwoFactorEmailRetryAfter(twoFactorToken);
      return res.status(429).json({
        success: false,
        message: 'Too many email code requests. Please wait before trying again.',
        code: 'TWO_FA_EMAIL_RATE_LIMIT',
        retryAfterSeconds,
      });
    }

    // Get user email
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [session.userId]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'User not found' });
    }

    const email = userResult.rows[0].email;
    const code = generateEmailCode();

    const nextSession = {
      ...session,
      emailCodeHash: hashEmailCode(twoFactorToken, code),
      emailCodeExpiresAt: Date.now() + 10 * 60 * 1000,
    };
    const updateStatus = await updatePendingTwoFactorSession(
      twoFactorToken,
      session,
      nextSession,
    );
    if (updateStatus !== 'updated') {
      return res.status(401).json({
        success: false,
        message: 'Session expired or changed. Please login again.',
        code: updateStatus === 'missing'
          ? 'TWO_FA_SESSION_USED'
          : 'TWO_FA_SESSION_CHANGED',
      });
    }

    await sendVerificationEmail(email, code);

    res.json({ success: true, message: 'Verification code sent to your email.' });
  } catch (err) {
    if (err instanceof SecurityCounterUnavailableError) {
      return sendTwoFactorCounterUnavailable(res);
    }
    console.error('2FA send email error:', err);
    return res.status(500).json({ success: false, message: 'Failed to send code' });
  }
});

// POST /api/auth/2fa/verify-login — Verify 2FA code and complete login
router.post('/', async (req, res) => {
  let dbClient = null;
  let transactionOpen = false;

  try {
    const { twoFactorToken, code } = req.body;
    const method = normalizeTwoFactorMethod(req.body.method);

    if (!twoFactorToken || !code || typeof req.body.method !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Token, code, and method are required.',
      });
    }

    // Validate pending session
    const session = await getPendingTwoFactorSession(twoFactorToken);
    if (!session || Date.now() > session.expiresAt) {
      await clearTwoFactorAttemptState(twoFactorToken);
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please login again.',
        code: 'TWO_FA_SESSION_EXPIRED',
      });
    }

    if (!isSameRequestBinding(session, req)) {
      await clearTwoFactorAttemptState(twoFactorToken);
      return res.status(401).json({
        success: false,
        message: '2FA session changed devices. Please login again.',
        code: 'TWO_FA_DEVICE_MISMATCH',
      });
    }

    const blockedState = await checkTwoFactorBlocked(twoFactorToken);
    if (blockedState.blocked) {
      await deletePendingTwoFactorSession(twoFactorToken);
      res.set('Retry-After', String(Math.max(1, blockedState.retryAfterSeconds)));
      return res.status(429).json({
        success: false,
        message: 'Too many invalid 2FA attempts. Please login again.',
        code: 'TWO_FA_RATE_LIMIT',
        retryAfterSeconds: blockedState.retryAfterSeconds,
      });
    }

    if (
      !method ||
      !await isTwoFactorMethodAuthorized(pool, session, method)
    ) {
      return sendFailedTwoFactorAttempt(
        res,
        twoFactorToken,
        'The selected verification method is unavailable.',
      );
    }

    const userId = session.userId;
    let backupCodeId = null;
    let verifiedEmailCodeHash = null;

    // Check if method is backup code
    if (method === 'backup') {
      const backupCodes = await pool.query(
        `SELECT id, code_hash FROM user_2fa_backup_codes WHERE user_id = $1 AND is_used = false`,
        [userId]
      );

      backupCodeId = await findMatchingBackupCodeId(backupCodes.rows, code);

      if (!backupCodeId) {
        return sendFailedTwoFactorAttempt(res, twoFactorToken, 'Invalid backup code.');
      }
    } else if (method === 'totp') {
      // Verify TOTP
      const result = await pool.query(
        `SELECT totp_secret FROM user_2fa WHERE user_id = $1 AND method = 'totp' AND is_enabled = true`,
        [userId]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Authenticator app is not set up.',
        });
      }

      const secret = decrypt(result.rows[0].totp_secret);
      const isValid = totp.verifyToken(code, secret);

      if (!isValid) {
        return sendFailedTwoFactorAttempt(
          res,
          twoFactorToken,
          'Invalid code. Please try again.',
        );
      }
    } else if (method === 'email') {
      // Verify email code
      if (!session.emailCodeHash || Date.now() > session.emailCodeExpiresAt) {
        return res.status(400).json({
          success: false,
          message: 'Email code expired. Please request a new one.',
        });
      }

      const submittedCodeHash = hashEmailCode(twoFactorToken, code);
      if (!safeEqualHex(session.emailCodeHash, submittedCodeHash)) {
        return sendFailedTwoFactorAttempt(
          res,
          twoFactorToken,
          'Invalid code. Please try again.',
        );
      }
      verifiedEmailCodeHash = submittedCodeHash;
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid verification method.',
      });
    }

    const challengeClaim = await claimVerifiedTwoFactorSession({
      twoFactorToken,
      expectedSession: session,
      method,
      req,
      queryable: pool,
      verifiedEmailCodeHash,
    });
    if (challengeClaim.status !== 'consumed') {
      return res.status(401).json({
        success: false,
        message: challengeClaim.status === 'missing'
          ? 'Session expired or already used. Please login again.'
          : 'Session changed during verification. Please login again.',
        code: challengeClaim.status === 'missing'
          ? 'TWO_FA_SESSION_USED'
          : 'TWO_FA_SESSION_CHANGED',
      });
    }

    dbClient = await pool.connect();
    await dbClient.query('BEGIN');
    transactionOpen = true;

    if (
      method === 'backup' &&
      !await consumeBackupCode(dbClient, backupCodeId, userId)
    ) {
      await dbClient.query('ROLLBACK');
      transactionOpen = false;
      return res.status(400).json({
        success: false,
        message: 'Invalid or already used backup code.',
        code: 'TWO_FA_BACKUP_CODE_USED',
      });
    }

    const userResult = await dbClient.query(
      'SELECT id, email, username, profile_id, is_verified FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];
    if (!user) {
      await dbClient.query('ROLLBACK');
      transactionOpen = false;
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please login again.',
        code: 'TWO_FA_SESSION_EXPIRED',
      });
    }

    const loginSession = await createLoginSessionRecord({
      queryable: dbClient,
      user,
      req,
      res,
    });

    await dbClient.query('COMMIT');
    transactionOpen = false;

    await activateLoginSession(loginSession);
    await IPSecurity.logIPActivity(req, 'LOGIN_SUCCESS', userId);
    await updateTrustScore(
      DeviceFingerprint.ensureFingerprint(req, res),
      'LOGIN_SUCCESS',
      req,
    );
    setLoginSessionCookies(req, res, loginSession);

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        profile_id: user.profile_id,
        is_verified: user.is_verified,
      },
      device: {
        id: loginSession.deviceId,
        name: loginSession.deviceInfo.deviceName,
        type: loginSession.deviceInfo.deviceType,
      },
    });
  } catch (err) {
    if (transactionOpen && dbClient) {
      try {
        await dbClient.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('2FA login transaction rollback error:', rollbackError);
      }
      transactionOpen = false;
    }
    if (err instanceof SecurityCounterUnavailableError) {
      return sendTwoFactorCounterUnavailable(res);
    }
    console.error('2FA verify login error:', err);
    return res.status(500).json({ success: false, message: 'Verification failed' });
  } finally {
    dbClient?.release();
  }
});

export default router;
