import { Router } from 'express';
import { pool } from '../../../db.js';
import { totp } from '../../services/totpService.js';
import { sendVerificationEmail } from '../../../middleware/emailService.js';
import { updateTrustScore } from '../../../middleware/captcha/trustScore.js';
import { DeviceFingerprint } from '../../../utils/deviceFingerprint.js';
import { IPSecurity } from '../../../utils/securityUtils.js';
import {
  decrypt,
  findMatchingBackupCodeId,
  safeEqualHex,
} from '../../services/twoFactorService.js';
import {
  checkTwoFactorBlocked,
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
  savePendingTwoFactorSession,
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

    // Store code in session
    session.emailCodeHash = hashEmailCode(twoFactorToken, code);
    session.emailCodeExpiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    await savePendingTwoFactorSession(twoFactorToken, session);

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

    // Check if method is backup code
    if (method === 'backup') {
      const backupCodes = await pool.query(
        `SELECT id, code_hash FROM user_2fa_backup_codes WHERE user_id = $1 AND is_used = false`,
        [userId]
      );

      const usedCodeId = await findMatchingBackupCodeId(backupCodes.rows, code);

      if (!usedCodeId) {
        return sendFailedTwoFactorAttempt(res, twoFactorToken, 'Invalid backup code.');
      }

      // Mark code as used
      await pool.query(
        `UPDATE user_2fa_backup_codes SET is_used = true, used_at = NOW() WHERE id = $1`,
        [usedCodeId]
      );
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
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid verification method.',
      });
    }

    // 2FA passed — complete login (issue tokens)
    await clearTwoFactorAttemptState(twoFactorToken);

    const userResult = await pool.query(
      'SELECT id, email, username, profile_id, is_verified FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];

    const loginSession = await createLoginSessionRecord({
      queryable: pool,
      user,
      req,
      res,
    });

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
    if (err instanceof SecurityCounterUnavailableError) {
      return sendTwoFactorCounterUnavailable(res);
    }
    console.error('2FA verify login error:', err);
    return res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

export default router;
