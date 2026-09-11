import { Router } from 'express';
import { pool } from '../../db.js';
import { IPSecurity } from '../../utils/securityUtils.js';
import { revokeCredentialRecords } from '../services/credentialInvalidation.js';
import { validateAccountPassword } from '../services/passwordPolicy.js';
import { hashPassword } from '../services/credentialService.js';
import { hashToken } from '../services/tokenService.js';

const router = Router();

router.post('/', async (req, res) => {
  const { token, newPassword } = req.body;
  let client;

  if (!token || !newPassword) {
    return res.status(400).json({ success: false, message: 'Token and new password required' });
  }

  const passwordError = validateAccountPassword(newPassword);
  if (passwordError) {
    return res.status(400).json({ success: false, message: passwordError });
  }

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const hashedToken = hashToken(token);
    const resetResult = await client.query(
      `SELECT user_id
       FROM password_resets
       WHERE token = $1
         AND expires_at > NOW()
       `,
      [hashedToken]
    );

    if (resetResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Token is invalid or expired' });
    }

    const user_id = resetResult.rows[0].user_id;
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user_id]);
    const lockedReset = await client.query(
      'SELECT user_id FROM password_resets WHERE token = $1 AND user_id = $2 AND expires_at > NOW() FOR UPDATE',
      [hashedToken, user_id],
    );
    if (!lockedReset.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Token is invalid or expired' });
    }

    const hashed = await hashPassword(newPassword);

    await client.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hashed, user_id]
    );

    await revokeCredentialRecords(client, user_id);

    await client.query('COMMIT');

    client.release();
    client = undefined;

    await IPSecurity.logIPActivity(req, 'PASSWORD_CHANGED', user_id);

    res.json({ success: true, message: 'Password has been reset' });
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, message: 'Failed to reset password' });
  } finally {
    client?.release();
  }
});

export default router;
