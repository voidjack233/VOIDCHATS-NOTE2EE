import { Router } from 'express';
import { pool } from '../../../db.js';
import { verifyPassword } from '../../services/credentialService.js';
import { generateBackupCodes } from '../../services/twoFactorService.js';
import {
  clearSensitiveTwoFactorActionFailures,
  reserveSensitiveTwoFactorActionAttempt,
} from '../../services/authAttemptLimitService.js';
import {
  handleSensitiveActionSecurityError,
  sendSensitiveActionRateLimit,
} from './actionSecurityResponses.js';

const router = Router();
const ACTION_NAME = 'regenerate_backup_codes';

// POST /api/auth/2fa/backup-codes/regenerate — Generate new backup codes
router.post('/regenerate', async (req, res) => {
  try {
    const userId = req.user.id;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required.',
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

    // Verify password
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

    // Check that at least one 2FA method is enabled
    const enabled = await pool.query(
      `SELECT COUNT(*) as count FROM user_2fa WHERE user_id = $1 AND is_enabled = true`,
      [userId]
    );

    if (parseInt(enabled.rows[0].count) === 0) {
      return res.status(400).json({
        success: false,
        message: 'Enable at least one 2FA method first.',
      });
    }

    const codes = await generateBackupCodes(userId);

    res.json({
      success: true,
      message: 'New backup codes generated. Previous codes are now invalid.',
      backupCodes: codes,
    });
  } catch (err) {
    const securityResponse = handleSensitiveActionSecurityError(res, err);
    if (securityResponse) return securityResponse;
    console.error('Backup codes regenerate error:', err);
    return res.status(500).json({ success: false, message: 'Failed to regenerate backup codes' });
  }
});

export default router;
