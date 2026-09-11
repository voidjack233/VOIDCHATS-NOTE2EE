import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../db.js';
import { IPSecurity } from '../../utils/securityUtils.js';
import { clearCookieOptions } from '../config/authCookies.js';
import { hashToken, isAuthTokenClaims, verifyRefreshToken } from '../services/tokenService.js';
import { sessionStore } from '../services/sessionService.js';
import { deleteRefreshRotationReceipt } from '../services/refreshRotationReceiptService.js';

const router = Router();
function clearAllCookies(req: Request, res: Response): void {
  for (const name of ['accessToken', 'refreshToken', '_csrf']) {
    res.clearCookie(name, clearCookieOptions(req));
    res.clearCookie(name, { path: '/', httpOnly: true });
  }
}

router.post('/', async (req, res) => {
  const token: unknown = req.cookies.refreshToken;
  let client: PoolClient | undefined;
  let userId: string | null = null;
  try {
    if (typeof token === 'string' && token) {
      let identity: { id: string; device_id: string; sid: string } | null = null;
      try {
        const decoded = verifyRefreshToken(token);
        if (isAuthTokenClaims(decoded, 'refresh')) identity = decoded;
      } catch { /* Expired tokens may revoke only their exact stored hash below. */ }
      client = await pool.connect();
      await client.query('BEGIN');
      if (!identity) {
        const exact = await client.query(
          'SELECT user_id AS id, device_id, session_id AS sid FROM refresh_tokens WHERE token_hash = $1', [hashToken(token)],
        );
        identity = exact.rows[0]?.sid ? exact.rows[0] : null;
      }
      if (identity) {
        userId = identity.id;
        const rows = await sessionStore.revoke(identity.id, identity.device_id, client, identity.sid);
        for (const row of rows) {
          if (row.previous_token_hash && row.token_hash) {
            await deleteRefreshRotationReceipt({ consumedTokenHash: row.previous_token_hash, replacementTokenHash: row.token_hash });
          }
        }
      }
      await client.query('COMMIT');
      client.release();
      client = undefined;
    }
    clearAllCookies(req, res);
    await IPSecurity.logIPActivity(req, 'LOGOUT_SUCCESS', userId);
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => {});
    console.error('Logout error:', error);
    clearAllCookies(req, res);
    res.status(503).json({ success: false, code: 'SESSION_INVALIDATION_UNAVAILABLE', message: 'Server session revocation failed. Please retry.' });
  } finally { client?.release(); }
});

export default router;
