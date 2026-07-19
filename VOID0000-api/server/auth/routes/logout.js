import { Router } from 'express';
import { pool } from '../../db.js';
import { IPSecurity } from '../../utils/securityUtils.js';
import { clearCookieOptions } from '../config/authCookies.js';
import {
  hashToken,
  verifyRefreshToken,
} from '../services/tokenService.js';
import { sessionStore } from '../services/sessionService.js';
import { deleteRefreshRotationReceipt } from '../services/refreshRotationReceiptService.js';
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
  const receiptPairsToDelete = [];

  try {
    if (refreshToken) {
      try {
        const decoded = verifyRefreshToken(refreshToken);
        userId = decoded.id;
        deviceId = decoded.device_id || null;

        if (userId && deviceId) {
          const revoked = await pool.query(
            `WITH target AS (
               SELECT id, token_hash, previous_token_hash
               FROM refresh_tokens
               WHERE user_id = $1 AND device_id = $2
               FOR UPDATE
             )
             UPDATE refresh_tokens AS rt
             SET is_revoked = TRUE,
                 revoked_at = NOW(),
                 previous_token_hash = NULL,
                 previous_jti = NULL,
                 previous_valid_until = NULL
             FROM target
             WHERE rt.id = target.id
             RETURNING
               target.token_hash AS revoked_token_hash,
               target.previous_token_hash AS revoked_previous_token_hash`,
            [userId, deviceId],
          );

          for (const row of revoked.rows) {
            if (row.revoked_previous_token_hash && row.revoked_token_hash) {
              receiptPairsToDelete.push({
                consumedTokenHash: row.revoked_previous_token_hash,
                replacementTokenHash: row.revoked_token_hash,
              });
            }
          }
        }
      } catch {
        const tokenHash = hashToken(refreshToken);
        const revoked = await pool.query(
          `WITH target AS (
             SELECT id, user_id, device_id, token_hash, previous_token_hash
             FROM refresh_tokens
             WHERE token_hash = $1
             FOR UPDATE
           )
           UPDATE refresh_tokens AS rt
           SET is_revoked = TRUE,
               revoked_at = NOW(),
               previous_token_hash = NULL,
               previous_jti = NULL,
               previous_valid_until = NULL
           FROM target
           WHERE rt.id = target.id
           RETURNING
             target.user_id,
             target.device_id,
             target.token_hash AS revoked_token_hash,
             target.previous_token_hash AS revoked_previous_token_hash`,
          [tokenHash],
        );

        if (revoked.rows.length > 0) {
          userId = revoked.rows[0].user_id;
          deviceId = revoked.rows[0].device_id;
          for (const row of revoked.rows) {
            if (row.revoked_previous_token_hash && row.revoked_token_hash) {
              receiptPairsToDelete.push({
                consumedTokenHash: row.revoked_previous_token_hash,
                replacementTokenHash: row.revoked_token_hash,
              });
            }
          }
        }
      }

      await Promise.all(
        receiptPairsToDelete.map((receiptPair) =>
          deleteRefreshRotationReceipt(receiptPair)
        ),
      );

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
