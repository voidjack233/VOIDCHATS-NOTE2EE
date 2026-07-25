import { Router } from 'express';
import { pool } from '../../../db.js';
import { totp } from '../../services/totpService.js';
import QRCode from 'qrcode';
import { verifyPassword } from '../../services/credentialService.js';
import { encrypt, decrypt } from '../../services/twoFactorService.js';
import {
  clearSensitiveTwoFactorActionFailures,
  reserveSensitiveTwoFactorActionAttempt,
} from '../../services/authAttemptLimitService.js';
import {
  handleSensitiveActionSecurityError,
  sendSensitiveActionRateLimit,
} from './actionSecurityResponses.js';

const router = Router();
const ACTION_NAME = 'setup_totp';

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
      'SELECT email, username, password_hash FROM users WHERE id = $1',
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
      `SELECT is_enabled FROM user_2fa WHERE user_id = $1 AND method = 'totp'`,
      [userId]
    );

    if (existing.rows.length > 0 && existing.rows[0].is_enabled) {
      return res.status(400).json({
        success: false,
        message: 'Authenticator app is already enabled. Disable it first to reconfigure.',
      });
    }

    const secret = totp.generateSecret();
    const otpauthUri = totp.generateOTPAuthURL(secret, user.email, 'VOID0000');
    const qrCode = await QRCode.toDataURL(otpauthUri, { width: 300, margin: 2 });
    const encryptedSecret = encrypt(secret);

    await pool.query(
      `INSERT INTO user_2fa (user_id, method, totp_secret, is_enabled, created_at)
       VALUES ($1, 'totp', $2, false, NOW())
       ON CONFLICT ON CONSTRAINT unique_user_method
       DO UPDATE SET totp_secret = $2, is_enabled = false, enabled_at = NULL, created_at = NOW()`,
      [userId, encryptedSecret]
    );

    res.json({
      success: true,
      secret,
      qrCode,
    });
  } catch (err) {
    const securityResponse = handleSensitiveActionSecurityError(res, err);
    if (securityResponse) return securityResponse;
    console.error('TOTP setup error:', err);
    return res.status(500).json({ success: false, message: 'Failed to set up authenticator' });
  }
});

export { encrypt, decrypt };
export default router;
