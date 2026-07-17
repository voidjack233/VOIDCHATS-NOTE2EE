import { Router } from 'express';
import { pool } from '../../db.js';
import { IPSecurity } from '../../utils/securityUtils.js';
import { authenticateUser } from '../middleware/authenticateUser.js';
import { encryptedCSRFProtection } from '../../middleware/encryptedCSRF.js';
import { totp } from '../services/totpService.js';
import {
  decrypt,
  findMatchingBackupCodeId,
  getActionEmailKey,
  hashActionEmailCode,
  safeEqualHex,
} from '../services/twoFactorService.js';
import valkey from '../../valkey.js';
import { validateAccountPassword } from '../services/passwordPolicy.js';
import {
  hashPassword,
  verifyPassword,
} from '../services/credentialService.js';

const router = Router();
const CHANGE_PASSWORD_EMAIL_ACTION = 'change_password';

router.post('/', authenticateUser, encryptedCSRFProtection, async (req, res) => {
  const { currentPassword, newPassword, twoFactorMethod, twoFactorCode } = req.body;
  const userId = req.user.id;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: 'Current password and new password are required'
    });
  }

  const passwordError = validateAccountPassword(newPassword);
  if (passwordError) {
    return res.status(400).json({
      success: false,
      message: passwordError
    });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({
      success: false,
      message: 'New password must be different from current password'
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const enabledMethodsResult = await client.query(
      `SELECT method FROM user_2fa WHERE user_id = $1 AND is_enabled = true`,
      [userId]
    );
    const enabledMethods = enabledMethodsResult.rows.map((row) => row.method);
    const requiresTwoFactor = enabledMethods.length > 0;

    if (requiresTwoFactor) {
      if (!twoFactorMethod || !twoFactorCode) {
        await client.query('ROLLBACK');
        return res.status(401).json({
          success: false,
          code: 'TWO_FACTOR_REQUIRED',
          message: 'This account requires a 2FA code before changing password.',
        });
      }

      if (twoFactorMethod === 'backup') {
        const backupCodes = await client.query(
          `SELECT id, code_hash FROM user_2fa_backup_codes WHERE user_id = $1 AND is_used = false`,
          [userId]
        );

        const usedCodeId = await findMatchingBackupCodeId(
          backupCodes.rows,
          String(twoFactorCode),
        );

        if (!usedCodeId) {
          await client.query('ROLLBACK');
          return res.status(401).json({
            success: false,
            code: 'TWO_FACTOR_INVALID',
            message: 'Invalid backup code.',
          });
        }

        await client.query(
          `UPDATE user_2fa_backup_codes SET is_used = true, used_at = NOW() WHERE id = $1`,
          [usedCodeId]
        );
      } else if (twoFactorMethod === 'totp') {
        if (!enabledMethods.includes('totp')) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            message: 'Authenticator app 2FA is not enabled on this account.',
          });
        }

        const secretResult = await client.query(
          `SELECT totp_secret FROM user_2fa WHERE user_id = $1 AND method = 'totp' AND is_enabled = true LIMIT 1`,
          [userId]
        );

        if (secretResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            message: 'Authenticator app 2FA is not enabled on this account.',
          });
        }

        const secret = decrypt(secretResult.rows[0].totp_secret);
        const isValid = totp.verifyToken(String(twoFactorCode).trim(), secret);
        if (!isValid) {
          await client.query('ROLLBACK');
          return res.status(401).json({
            success: false,
            code: 'TWO_FACTOR_INVALID',
            message: 'Invalid authenticator code.',
          });
        }
      } else if (twoFactorMethod === 'email') {
        if (!enabledMethods.includes('email')) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            message: 'Email 2FA is not enabled on this account.',
          });
        }

        const raw = await valkey.get(getActionEmailKey(userId, CHANGE_PASSWORD_EMAIL_ACTION));
        const stored = raw ? JSON.parse(raw) : null;

        const submittedCodeHash = hashActionEmailCode(
          userId,
          CHANGE_PASSWORD_EMAIL_ACTION,
          twoFactorCode,
        );
        if (!stored?.codeHash || !safeEqualHex(stored.codeHash, submittedCodeHash)) {
          await client.query('ROLLBACK');
          return res.status(401).json({
            success: false,
            code: 'TWO_FACTOR_INVALID',
            message: 'Invalid email verification code.',
          });
        }

        await valkey.del(getActionEmailKey(userId, CHANGE_PASSWORD_EMAIL_ACTION));
      } else {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Unsupported 2FA verification method.',
        });
      }
    }

    const userResult = await client.query(
      'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );

    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = userResult.rows[0];

    const isValid = await verifyPassword(user.password_hash, currentPassword);

    if (!isValid) {
      await client.query('ROLLBACK');
      await IPSecurity.logIPActivity(req, 'PASSWORD_CHANGE_FAILED_WRONG_PASSWORD', userId);
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    const newHash = await hashPassword(newPassword);

    await client.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, userId]
    );

    await client.query('COMMIT');
    await IPSecurity.logIPActivity(req, 'PASSWORD_CHANGE_SUCCESS', userId);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('Change password error:', err);
    await IPSecurity.logIPActivity(req, 'PASSWORD_CHANGE_ERROR', userId);
    res.status(500).json({
      success: false,
      message: 'Failed to change password'
    });
  } finally {
    client?.release();
  }
});

export default router;
