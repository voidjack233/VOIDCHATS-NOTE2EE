import { Router } from 'express';
import { pool } from '../../../db.js';
import { sendVerificationEmail } from '../../../middleware/emailService.js';
import { verifyPassword } from '../../services/credentialService.js';
import {
  generateSetupEmailCode,
  hashSetupEmailCode,
} from '../../services/twoFactorService.js';
import {
  clearSensitiveTwoFactorActionFailures,
  reserveSensitiveTwoFactorActionAttempt,
} from '../../services/authAttemptLimitService.js';
import {
  handleSensitiveActionSecurityError,
  sendSensitiveActionRateLimit,
} from './actionSecurityResponses.js';

const router = Router();
const ACTION_NAME = 'setup_email';

router.post('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required to set up 2FA.',
      });
    }

    const attemptState = await reserveSensitiveTwoFactorActionAttempt({
      req,
      userId,
      action: ACTION_NAME,
    });
    if (attemptState.blocked) {
      return sendSensitiveActionRateLimit(res, attemptState);
    }

    const userResult = await pool.query(
      'SELECT email, password_hash FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];

    const match = await verifyPassword(user.password_hash, password);
    if (!match) {
      if (attemptState.limitReached) {
        return sendSensitiveActionRateLimit(res, attemptState);
      }
      return res.status(401).json({
        success: false,
        message: 'Incorrect password.',
      });
    }
    await clearSensitiveTwoFactorActionFailures({
      req,
      userId,
      action: ACTION_NAME,
    });

    const existing = await pool.query(
      `SELECT is_enabled FROM user_2fa WHERE user_id = $1 AND method = 'email'`,
      [userId]
    );

    if (existing.rows.length > 0 && existing.rows[0].is_enabled) {
      return res.status(400).json({
        success: false,
        message: 'Email 2FA is already enabled.',
      });
    }

    await pool.query(
      `INSERT INTO user_2fa (user_id, method, is_enabled, created_at)
       VALUES ($1, 'email', false, NOW())
       ON CONFLICT ON CONSTRAINT unique_user_method
       DO UPDATE SET is_enabled = false, enabled_at = NULL, created_at = NOW()`,
      [userId]
    );

    const code = generateSetupEmailCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `UPDATE user_2fa SET totp_secret = $1 WHERE user_id = $2 AND method = 'email'`,
      [JSON.stringify({ codeHash: hashSetupEmailCode(userId, code), expiresAt }), userId]
    );

    await sendVerificationEmail(user.email, code);

    res.json({
      success: true,
      message: 'Verification code sent to your email.',
    });
  } catch (err) {
    const securityResponse = handleSensitiveActionSecurityError(res, err);
    if (securityResponse) return securityResponse;
    console.error('Email 2FA setup error:', err);
    return res.status(500).json({ success: false, message: 'Failed to set up email 2FA' });
  }
});

export default router;
