import { Router } from 'express';
import { pool } from '../../../db.js';
import { totp } from '../../services/totpService.js';
import {
  decrypt,
  generateBackupCodes,
  hashSetupEmailCode,
  safeEqualHex,
} from '../../services/twoFactorService.js';

const router = Router();

// POST /api/auth/2fa/verify-setup — Confirm 2FA setup with a test code
router.post('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { method, code } = req.body;

    if (!method || !code) {
      return res.status(400).json({
        success: false,
        message: 'Method and code are required.',
      });
    }

    const result = await pool.query(
      `SELECT * FROM user_2fa WHERE user_id = $1 AND method = $2`,
      [userId, method]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please start the setup process first.',
      });
    }

    const record = result.rows[0];

    if (record.is_enabled) {
      return res.status(400).json({
        success: false,
        message: '2FA is already enabled for this method.',
      });
    }

    // Verify based on method
    if (method === 'totp') {
      const secret = decrypt(record.totp_secret);
      const isValid = totp.verifyToken(code, secret);

      if (!isValid) {
        return res.status(400).json({
          success: false,
          message: 'Invalid code. Please try again.',
        });
      }
    } else if (method === 'email') {
      const stored = JSON.parse(record.totp_secret);

      if (Date.now() > new Date(stored.expiresAt).getTime()) {
        return res.status(400).json({
          success: false,
          message: 'Code has expired. Please request a new one.',
        });
      }

      const submittedCodeHash = hashSetupEmailCode(userId, code);
      const matchesHashedCode =
        stored.codeHash && safeEqualHex(stored.codeHash, submittedCodeHash);

      if (!matchesHashedCode) {
        return res.status(400).json({
          success: false,
          message: 'Invalid code. Please try again.',
        });
      }

      // Clear the temporary code
      await pool.query(
        `UPDATE user_2fa SET totp_secret = NULL WHERE user_id = $1 AND method = 'email'`,
        [userId]
      );
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid 2FA method.',
      });
    }

    // Enable 2FA
    await pool.query(
      `UPDATE user_2fa SET is_enabled = true, enabled_at = NOW() WHERE user_id = $1 AND method = $2`,
      [userId, method]
    );

    // Generate backup codes if this is the first 2FA method enabled
    const enabledMethods = await pool.query(
      `SELECT COUNT(*) as count FROM user_2fa WHERE user_id = $1 AND is_enabled = true`,
      [userId]
    );

    let backupCodes = null;

    // Generate backup codes on first 2FA enable (count was 0 before we just enabled)
    if (parseInt(enabledMethods.rows[0].count) === 1) {
      backupCodes = await generateBackupCodes(userId);
    }

    res.json({
      success: true,
      message: `${method === 'totp' ? 'Authenticator app' : 'Email 2FA'} has been enabled.`,
      backupCodes, // Only returned on first enable
    });
  } catch (err) {
    console.error('2FA verify setup error:', err);
    res.status(500).json({ success: false, message: 'Failed to verify 2FA setup' });
  }
});

export { generateBackupCodes };
export default router;
