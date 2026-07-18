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
  signAccessToken,
  verifyRefreshToken,
} from '../services/tokenService.js';
import { sessionStore } from '../services/sessionService.js';
import { syncLiveTokenExpiry } from '../../gateway/control.js';
import { debugLog } from '../../utils/debugLog.js';

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

const clearAuthCookies = (req, res) => {
  res.clearCookie('accessToken', clearCookieOptions(req));
  res.clearCookie('refreshToken', clearCookieOptions(req));
};

const getSessionMetadata = (req, tokenRecord) => ({
  ip: normalizeIP(getClientIP(req)),
  userAgent: req.get('User-Agent') || 'unknown',
  deviceName: tokenRecord.device_name || 'Unknown',
  deviceType: tokenRecord.device_type || 'unknown',
});

router.post('/', async (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({
      success: false,
      code: 'NO_REFRESH_TOKEN',
      message: 'No refresh token',
    });
  }

  let client;
  let transactionOpen = false;

  try {
    const decoded = verifyRefreshToken(refreshToken);

    if (!decoded.id || !decoded.profile_id || !decoded.jti || !decoded.device_id) {
      return res.status(403).json({
        success: false,
        code: 'TOKEN_INVALID',
        message: 'Malformed token',
      });
    }

    if (decoded.type !== 'refresh') {
      return res.status(403).json({
        success: false,
        code: 'TOKEN_INVALID',
        message: 'Wrong token type',
      });
    }

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
      [decoded.jti, decoded.id, tokenHash],
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionOpen = false;

      const activeSessionResult = await client.query(
        `SELECT rt.device_name, rt.device_type, u.is_verified
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         WHERE rt.user_id = $1
           AND rt.device_id = $2
           AND rt.is_revoked = FALSE
           AND rt.expires_at > NOW()
         LIMIT 1`,
        [decoded.id, decoded.device_id],
      );
      const activeSession = activeSessionResult.rows[0];

      if (activeSession) {
        if (!activeSession.is_verified) {
          return res.status(403).json({
            success: false,
            code: 'USER_NOT_VERIFIED',
            message: 'Account verification required',
          });
        }

        const accessToken = signAccessToken({
          id: decoded.id,
          profile_id: decoded.profile_id,
          device_id: decoded.device_id,
        });
        const accessTokenDecoded = decodeAuthToken(accessToken);
        const sessionMetadata = getSessionMetadata(req, activeSession);

        res.cookie('accessToken', accessToken, accessCookieOptions(req));
        res.json({
          success: true,
          message: 'Token refreshed (race recovery)',
        });

        debugLog('[AUTH_REFRESH] refresh race recovered with access token', {
          user_id: decoded.id,
          device_id: decoded.device_id,
        });
        syncRefreshStateBestEffort({
          userId: decoded.id,
          deviceId: decoded.device_id,
          accessTokenExp: accessTokenDecoded?.exp,
          sessionMetadata,
        });
        return;
      }

      clearAuthCookies(req, res);
      return res.status(403).json({
        success: false,
        code: 'REFRESH_TOKEN_INVALID',
        message: 'Session expired. Please login again.',
      });
    }

    const tokenRecord = result.rows[0];

    if (tokenRecord.device_id !== decoded.device_id) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return res.status(403).json({
        success: false,
        code: 'DEVICE_MISMATCH',
        message: 'Device verification failed',
      });
    }

    if (!tokenRecord.is_verified) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return res.status(403).json({
        success: false,
        code: 'USER_NOT_VERIFIED',
        message: 'Account verification required',
      });
    }

    const newTokens = createTokenPair({
      userId: decoded.id,
      profileId: decoded.profile_id,
      deviceId: decoded.device_id,
    });
    const newAccessDecoded = decodeAuthToken(newTokens.accessToken);
    const sessionMetadata = getSessionMetadata(req, tokenRecord);

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
        sessionMetadata.ip,
        sessionMetadata.userAgent,
        decoded.device_id,
        sessionMetadata.deviceName,
        sessionMetadata.deviceType,
      ],
    );

    await client.query(
      `DELETE FROM refresh_tokens
       WHERE expires_at < NOW() - INTERVAL '7 days'
          OR (is_revoked = TRUE AND revoked_at < NOW() - INTERVAL '7 days')`,
    );

    await client.query('COMMIT');
    transactionOpen = false;

    res.cookie('accessToken', newTokens.accessToken, accessCookieOptions(req));
    res.cookie('refreshToken', newTokens.refreshToken, refreshCookieOptions(req));
    res.json({
      success: true,
      message: 'Token refreshed',
    });

    syncRefreshStateBestEffort({
      userId: decoded.id,
      deviceId: decoded.device_id,
      accessTokenExp: newAccessDecoded?.exp,
      sessionMetadata,
    });
  } catch (error) {
    if (client && transactionOpen) {
      await client.query('ROLLBACK').catch((rollbackError) => {
        console.error('Refresh rollback error:', rollbackError);
      });
      transactionOpen = false;
    }

    console.error('Refresh error:', error);

    if (res.headersSent) return;

    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      clearAuthCookies(req, res);
      return res.status(403).json({
        success: false,
        code: error.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
        message: 'Session expired. Please login again.',
      });
    }

    return res.status(500).json({
      success: false,
      code: 'REFRESH_FAILED',
      message: 'Refresh failed, please try again',
    });
  } finally {
    client?.release();
  }
});

export default router;
