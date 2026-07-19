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
import {
  getRefreshRotationReceipt,
  REFRESH_PREDECESSOR_GRACE_SECONDS,
  storeRefreshRotationReceipt,
} from '../services/refreshRotationReceiptService.js';
import { syncLiveTokenExpiry } from '../../gateway/control.js';
import { debugLog } from '../../utils/debugLog.js';

const router = Router();

const normalizeIP = (ip) => {
  if (!ip) return null;
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
};

const syncRefreshGatewayBestEffort = ({
  userId,
  deviceId,
  accessTokenExp,
}) => {
  if (!Number.isInteger(accessTokenExp)) return;

  void syncLiveTokenExpiry(userId, deviceId, accessTokenExp).catch((error) => {
    console.warn('[AUTH_REFRESH] best-effort gateway synchronization failed', {
      user_id: userId,
      error: error instanceof Error ? error.message : String(error || ''),
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

const getReplacementRefreshToken = ({ receipt, tokenRecord, decoded }) => {
  if (
    !receipt ||
    receipt.replacementTokenHash !== tokenRecord.token_hash ||
    receipt.replacementJti !== String(tokenRecord.jti)
  ) {
    return null;
  }

  try {
    const replacementDecoded = verifyRefreshToken(receipt.replacementRefreshToken);
    const hasMatchingIdentity =
      replacementDecoded.type === 'refresh' &&
      replacementDecoded.id === decoded.id &&
      replacementDecoded.profile_id === decoded.profile_id &&
      replacementDecoded.device_id === decoded.device_id &&
      replacementDecoded.jti === String(tokenRecord.jti) &&
      hashToken(receipt.replacementRefreshToken) === tokenRecord.token_hash;

    return hasMatchingIdentity ? receipt.replacementRefreshToken : null;
  } catch {
    return null;
  }
};

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
         AND rt.device_id = $4
         AND rt.expires_at > NOW()
         AND rt.is_revoked = FALSE
       FOR UPDATE OF rt`,
      [decoded.jti, decoded.id, tokenHash, decoded.device_id],
    );

    if (result.rows.length === 0) {
      const predecessorResult = await client.query(
        `SELECT rt.*, u.is_verified
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         WHERE rt.user_id = $1
           AND rt.device_id = $2
           AND rt.previous_token_hash = $3
           AND rt.previous_jti = $4
           AND rt.previous_valid_until > clock_timestamp()
           AND rt.is_revoked = FALSE
           AND rt.expires_at > NOW()
           AND u.is_verified = TRUE
         FOR UPDATE OF rt`,
        [decoded.id, decoded.device_id, tokenHash, decoded.jti],
      );

      if (predecessorResult.rows.length === 0) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        clearAuthCookies(req, res);
        return res.status(403).json({
          success: false,
          code: 'REFRESH_TOKEN_INVALID',
          message: 'Session expired. Please login again.',
        });
      }

      const tokenRecord = predecessorResult.rows[0];
      const receipt = await getRefreshRotationReceipt({
        consumedTokenHash: tokenHash,
        consumedJti: decoded.jti,
        userId: decoded.id,
        deviceId: decoded.device_id,
        replacementTokenHash: tokenRecord.token_hash,
      });
      const replacementRefreshToken = getReplacementRefreshToken({
        receipt,
        tokenRecord,
        decoded,
      });
      const accessToken = signAccessToken({
        id: decoded.id,
        profile_id: decoded.profile_id,
        device_id: decoded.device_id,
      });
      const accessTokenDecoded = decodeAuthToken(accessToken);

      await client.query('COMMIT');
      transactionOpen = false;

      res.cookie('accessToken', accessToken, accessCookieOptions(req));
      if (replacementRefreshToken) {
        res.cookie('refreshToken', replacementRefreshToken, refreshCookieOptions(req));
      }
      res.json({
        success: true,
        message: 'Token refreshed (race recovery)',
      });

      debugLog('[AUTH_REFRESH] exact predecessor race recovered', {
        user_id: decoded.id,
        device_id: decoded.device_id,
        replacement_replayed: Boolean(replacementRefreshToken),
      });
      syncRefreshGatewayBestEffort({
        userId: decoded.id,
        deviceId: decoded.device_id,
        accessTokenExp: accessTokenDecoded?.exp,
      });
      return;
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
      `DELETE FROM refresh_tokens
       WHERE expires_at < NOW() - INTERVAL '7 days'
          OR (is_revoked = TRUE AND revoked_at < NOW() - INTERVAL '7 days')`,
    );

    await client.query(
      `UPDATE refresh_tokens
       SET previous_token_hash = token_hash,
           previous_jti = jti,
           previous_valid_until = clock_timestamp() + ($1::integer * INTERVAL '1 second'),
           token_hash = $2,
           jti = $3,
           expires_at = NOW() + INTERVAL '30 days',
           ip_address = $4,
           user_agent = $5,
           device_name = $6,
           device_type = $7,
           last_used_at = NOW(),
           is_revoked = FALSE,
           revoked_at = NULL,
           revoked_by = NULL
       WHERE id = $8`,
      [
        REFRESH_PREDECESSOR_GRACE_SECONDS,
        newTokens.refreshTokenHash,
        newTokens.refreshJti,
        sessionMetadata.ip,
        sessionMetadata.userAgent,
        sessionMetadata.deviceName,
        sessionMetadata.deviceType,
        tokenRecord.id,
      ],
    );

    const receiptStored = await storeRefreshRotationReceipt({
      consumedTokenHash: tokenHash,
      consumedJti: decoded.jti,
      userId: decoded.id,
      deviceId: decoded.device_id,
      replacementTokenHash: newTokens.refreshTokenHash,
      replacementJti: newTokens.refreshJti,
      replacementRefreshToken: newTokens.refreshToken,
    });
    if (!receiptStored) {
      debugLog('[AUTH_REFRESH] rotation receipt unavailable', {
        user_id: decoded.id,
        device_id: decoded.device_id,
      });
    }

    await client.query('COMMIT');
    transactionOpen = false;

    res.cookie('accessToken', newTokens.accessToken, accessCookieOptions(req));
    res.cookie('refreshToken', newTokens.refreshToken, refreshCookieOptions(req));
    res.json({
      success: true,
      message: 'Token refreshed',
    });

    syncRefreshGatewayBestEffort({
      userId: decoded.id,
      deviceId: decoded.device_id,
      accessTokenExp: newAccessDecoded?.exp,
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
