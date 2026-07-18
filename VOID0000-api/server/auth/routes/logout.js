import { Router } from 'express';
import { pool } from '../../db.js';
import { IPSecurity } from '../../utils/securityUtils.js';
import { clearCookieOptions } from '../config/authCookies.js';
import {
  hashToken,
  verifyRefreshToken,
} from '../services/tokenService.js';
import { sessionStore } from '../services/sessionService.js';
import { disconnectLiveSession } from '../../gateway/control.js';

const router = Router();

function clearAllCookies(req, res) {
  const cookieNames = ['accessToken', 'refreshToken', '_csrf'];

  cookieNames.forEach((name) => {
    res.clearCookie(name, clearCookieOptions(req));
  });

  cookieNames.forEach((name) => {
    res.clearCookie(name, { path: '/', httpOnly: true });
  });
}

router.post('/', async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  let userId = null;
  let deviceId = null;

  try {
    if (refreshToken) {
      try {
        const decoded = verifyRefreshToken(refreshToken);
        userId = decoded.id;
        deviceId = decoded.device_id || null;

        if (userId && deviceId) {
          await pool.query(
            `UPDATE refresh_tokens
             SET is_revoked = TRUE, revoked_at = NOW()
             WHERE user_id = $1 AND device_id = $2`,
            [userId, deviceId],
          );
        }
      } catch {
        const tokenHash = hashToken(refreshToken);
        const revoked = await pool.query(
          `UPDATE refresh_tokens
           SET is_revoked = TRUE, revoked_at = NOW()
           WHERE token_hash = $1
           RETURNING user_id, device_id`,
          [tokenHash],
        );

        if (revoked.rows.length > 0) {
          userId = revoked.rows[0].user_id;
          deviceId = revoked.rows[0].device_id;
        }
      }

      if (userId && deviceId) {
        await sessionStore.revoke(userId, deviceId);
        await disconnectLiveSession(userId, deviceId);
      }
    }

    clearAllCookies(req, res);
    await IPSecurity.logIPActivity(req, 'LOGOUT_SUCCESS', userId);

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    console.error('Logout error:', error);

    clearAllCookies(req, res);
    await IPSecurity.logIPActivity(req, 'LOGOUT_FAILED', userId);

    res.json({ success: true });
  }
});

export default router;
