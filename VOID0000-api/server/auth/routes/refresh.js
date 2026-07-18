import { Router } from 'express';
import { pool } from '../../db.js';
import { getClientIP } from '../../utils/securityUtils.js';
import {
  accessCookieOptions,
  refreshCookieOptions,
  clearCookieOptions,
} from '../config/authCookies.js';
import {
  createTokenPair,
  decodeAuthToken,
  hashToken,
  verifyRefreshToken,
} from '../services/tokenService.js';
import { sessionStore } from '../services/sessionService.js';
import { syncLiveTokenExpiry } from '../../gateway/control.js';
import { debugLog } from '../../utils/debugLog.js';
import { classifyRefreshTokenMiss } from '../services/refreshPolicy.js';

const router = Router();

const normalizeIP = (ip) => {
  if (!ip) return null;
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
};

const syncRefreshStateBestEffort = ({
  userId,
  deviceId,
  accessTokenExp,
  sessionMetadata,
}) => {
  const sessionSync = (async () => {
    const touched = await sessionStore.touch(userId, deviceId);
    if (!touched) {
      await sessionStore.create(userId, deviceId, sessionMetadata);
    }
  })();
  const gatewaySync = Number.isInteger(accessTokenExp)
    ? syncLiveTokenExpiry(userId, deviceId, accessTokenExp)
    : Promise.resolve();

  void Promise.allSettled([sessionSync, gatewaySync]).then((results) => {
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return;
      console.warn('[AUTH_REFRESH] best-effort synchronization failed', {
        user_id: userId,
        target: index === 0 ? 'session' : 'gateway',
        error: result.reason instanceof Error ? result.reason.message : String(result.reason || ''),
      });
    });
  });
};

router.post('/', async (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({
      success: false,
      code: 'NO_REFRESH_TOKEN',
      message: 'No refresh token'
    });
  }

  let client;
  let transactionOpen = false;

  try {
    // 1. VERIFY JWT STRUCTURE
    const decoded = verifyRefreshToken(refreshToken);

    if (!decoded.id || !decoded.profile_id || !decoded.jti || !decoded.device_id) {
      console.error('Invalid JWT payload:', decoded);
      return res.status(403).json({
        success: false,
        code: 'TOKEN_INVALID',
        message: 'Malformed token'
      });
    }

    if (decoded.type !== 'refresh') {
      return res.status(403).json({
        success: false,
        code: 'TOKEN_INVALID',
        message: 'Wrong token type'
      });
    }

    // 2. DATABASE LOOKUP
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;

    const tokenHash = hashToken(refreshToken);

    const result = await client.query(
      `SELECT rt.*, u.is_verified
       FROM refresh_tokens rt
       JOIN users u ON rt.user_id = u.id
       WHERE rt.jti = $1
         AND rt.user_id = $2
         AND rt.token_hash = $3
         AND rt.expires_at > NOW()
         AND rt.is_revoked = FALSE
       FOR UPDATE OF rt`,
      [decoded.jti, decoded.id, tokenHash]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionOpen = false;

      const deviceCheck = await pool.query(
        `SELECT 1 FROM refresh_tokens
         WHERE user_id = $1
           AND device_id = $2
           AND is_revoked = FALSE
           AND expires_at > NOW()
         LIMIT 1`,
        [decoded.id, decoded.device_id]
      );
      const miss = classifyRefreshTokenMiss(deviceCheck.rows.length > 0);

      if (miss.kind === 'rotated') {
        // A concurrent request may have won the row lock and updated the shared
        // browser cookie. Never authorize with the consumed token itself.
        res.set('Retry-After', '1');
        debugLog(`[AUTH_REFRESH] consumed token rejected for user ${decoded.id.substring(0, 8)}...`);
        return res.status(miss.status).json(miss.body);
      }

      res.clearCookie('accessToken', clearCookieOptions(req));
      res.clearCookie('refreshToken', clearCookieOptions(req));

      return res.status(miss.status).json(miss.body);
    }

    const tokenRecord = result.rows[0];

    if (tokenRecord.device_id !== decoded.device_id) {
      console.error('Device mismatch:', {
        tokenDevice: tokenRecord.device_id,
        jwtDevice: decoded.device_id
      });
      await client.query('ROLLBACK');
      transactionOpen = false;
      return res.status(403).json({
        success: false,
        code: 'DEVICE_MISMATCH',
        message: 'Device verification failed'
      });
    }

    if (!tokenRecord.is_verified) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return res.status(403).json({
        success: false,
        code: 'USER_NOT_VERIFIED',
        message: 'Account verification required'
      });
    }

    // 3. GENERATE NEW TOKENS
    const newTokens = createTokenPair({
      userId: decoded.id,
      profileId: decoded.profile_id,
      deviceId: decoded.device_id,
    });
    const newAccessDecoded = decodeAuthToken(newTokens.accessToken);

    await client.query(
      `INSERT INTO refresh_tokens
        (user_id, token_hash, jti, expires_at, ip_address, user_agent, device_id, device_name, device_type, last_used_at, is_revoked, revoked_at, created_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', $4, $5, $6, $7, $8, NOW(), FALSE, NULL, NOW())
       ON CONFLICT ON CONSTRAINT unique_user_device
       DO UPDATE SET
         token_hash = EXCLUDED.token_hash,
         jti = EXCLUDED.jti,
         expires_at = EXCLUDED.expires_at,
         ip_address = EXCLUDED.ip_address,
         user_agent = EXCLUDED.user_agent,
         last_used_at = NOW(),
         is_revoked = FALSE,
         revoked_at = NULL`,
      [
        decoded.id,
        newTokens.refreshTokenHash,
        newTokens.refreshJti,
        normalizeIP(getClientIP(req)),
        req.get('User-Agent') || 'unknown',
        decoded.device_id,
        tokenRecord.device_name || 'Unknown',
        tokenRecord.device_type || 'unknown'
      ]
    );

    // 5. CLEANUP
    await client.query(
      `DELETE FROM refresh_tokens
       WHERE expires_at < NOW() - INTERVAL '7 days'
          OR (is_revoked = TRUE AND revoked_at < NOW() - INTERVAL '7 days')`
    );

    await client.query('COMMIT');
    transactionOpen = false;

    // 6. SET COOKIES
    res.cookie('accessToken', newTokens.accessToken, accessCookieOptions(req));
    res.cookie('refreshToken', newTokens.refreshToken, refreshCookieOptions(req));

    res.json({
      success: true,
      message: 'Token refreshed'
    });

    syncRefreshStateBestEffort({
      userId: decoded.id,
      deviceId: decoded.device_id,
      accessTokenExp: newAccessDecoded?.exp,
      sessionMetadata: {
        ip: normalizeIP(getClientIP(req)),
        userAgent: req.get('User-Agent') || 'unknown',
        deviceName: tokenRecord.device_name || 'Unknown',
        deviceType: tokenRecord.device_type || 'unknown',
      },
    });

  } catch (err) {
    if (client && transactionOpen) {
      await client.query('ROLLBACK').catch((rollbackError) => {
        console.error('Refresh rollback error:', rollbackError);
      });
      transactionOpen = false;
    }

    console.error('Refresh error:', err);

    if (res.headersSent) return;

    // Only clear cookies for definitive token errors
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      res.clearCookie('accessToken', clearCookieOptions(req));
      res.clearCookie('refreshToken', clearCookieOptions(req));

      return res.status(403).json({
        success: false,
        code: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
        message: 'Session expired. Please login again.'
      });
    }

    // Transient error (DB hiccup, etc.) — don't destroy the session
    return res.status(500).json({
      success: false,
      code: 'REFRESH_FAILED',
      message: 'Refresh failed, please try again'
    });
  } finally {
    if (client) client.release();
  }
});

export default router;
