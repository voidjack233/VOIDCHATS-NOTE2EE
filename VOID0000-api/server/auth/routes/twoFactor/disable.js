import { Router } from 'express';
import { pool } from '../../../db.js';
import { verifyPassword } from '../../services/credentialService.js';
import {
  clearSensitiveTwoFactorActionFailures,
  reserveSensitiveTwoFactorActionAttempt,
} from '../../services/authAttemptLimitService.js';
import {
  handleSensitiveActionSecurityError,
  sendSensitiveActionRateLimit,
} from './actionSecurityResponses.js';

const router = Router();
const ACTION_NAME = 'disable';

// POST /api/auth/2fa/disable — Disable a 2FA method
router.post('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { method, password } = req.body;

    if (!method || !password) {
      return res.status(400).json({
        success: false,
        message: 'Method and password are required.',
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

    // Verify password first
    const userResult = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId]
    );

    const match = await verifyPassword(userResult.rows[0].password_hash, password);
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

    // Disable the method
    const result = await pool.query(
      `UPDATE user_2fa SET is_enabled = false, enabled_at = NULL
       WHERE user_id = $1 AND method = $2 AND is_enabled = true
       RETURNING *`,
      [userId, method]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'This 2FA method is not currently enabled.',
      });
    }

    // Check if any 2FA methods remain enabled
    const remaining = await pool.query(
      `SELECT COUNT(*) as count FROM user_2fa WHERE user_id = $1 AND is_enabled = true`,
      [userId]
    );

    // If no 2FA methods left, delete backup codes
    if (parseInt(remaining.rows[0].count) === 0) {
      await pool.query('DELETE FROM user_2fa_backup_codes WHERE user_id = $1', [userId]);
    }

    res.json({
      success: true,
      message: `${method === 'totp' ? 'Authenticator app' : 'Email 2FA'} has been disabled.`,
    });
  } catch (err) {
    const securityResponse = handleSensitiveActionSecurityError(res, err);
    if (securityResponse) return securityResponse;
    console.error('2FA disable error:', err);
    return res.status(500).json({ success: false, message: 'Failed to disable 2FA' });
  }
});

export default router;
