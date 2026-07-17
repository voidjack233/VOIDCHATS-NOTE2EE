import { Router } from 'express';
import { pool } from '../../db.js';
import { IPSecurity, getClientIP } from '../../utils/securityUtils.js';
import { updateTrustScore } from '../../middleware/captcha/trustScore.js';
import { DeviceFingerprint } from '../../utils/deviceFingerprint.js';
import { create2FASession } from '../services/twoFactorChallengeService.js';
import {
  rehashPasswordIfNeeded,
  verifyPassword,
} from '../services/credentialService.js';
import {
  activateLoginSession,
  createLoginDeviceContext,
  createLoginSessionRecord,
  setLoginSessionCookies,
} from '../services/loginSessionService.js';

const router = Router();

const normalizeIP = (ip) => {
  if (!ip) return null;
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
};

router.post('/', async (req, res) => {
  let { identifier, password } = req.body;

  if (typeof identifier !== 'string' || identifier.length > 255 ||
    typeof password !== 'string' || password.length > 128) {
    await IPSecurity.logIPActivity(req, 'LOGIN_FAILURE_BAD_INPUT');
    return res.status(400).json({ success: false, message: "Invalid credentials format" });
  }

  let userIp = normalizeIP(getClientIP(req));
  const userAgent = req.get('User-Agent') || 'unknown';
  const trustDeviceId = DeviceFingerprint.ensureFingerprint(req, res);

  let client;

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = $1 OR LOWER(username) = $1',
      [identifier.trim().toLowerCase()]
    );

    const user = result.rows[0];

    if (!user) {
      await IPSecurity.logIPActivity(req, 'LOGIN_FAILURE_USER_NOT_FOUND');
      await updateTrustScore(trustDeviceId, 'LOGIN_FAILED', req);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const match = await verifyPassword(user.password_hash, password);
    if (!match) {
      await IPSecurity.logIPActivity(req, 'LOGIN_FAILURE_WRONG_PASSWORD', user.id);
      await updateTrustScore(trustDeviceId, 'LOGIN_FAILED', req);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (!user.is_verified) {
      await IPSecurity.logIPActivity(req, 'LOGIN_FAILURE_EMAIL_NOT_VERIFIED', user.id);
      return res.status(403).json({
        success: false,
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email before logging in.',
        email: user.email
      });
    }

    // Check if user has 2FA enabled
    const twoFAResult = await pool.query(
      `SELECT method FROM user_2fa WHERE user_id = $1 AND is_enabled = true`,
      [user.id]
    );

    if (twoFAResult.rows.length > 0) {
      const methods = twoFAResult.rows.map(r => r.method);
      const twoFactorToken = await create2FASession(user.id, req);

      // Record successful password auth for trust scoring
      await updateTrustScore(trustDeviceId, 'LOGIN_SUCCESS', req);

      return res.json({
        success: true,
        requires2FA: true,
        twoFactorToken,
        methods, // ['totp', 'email'] or ['totp'] or ['email']
        defaultMethod: methods.includes('totp') ? 'totp' : 'email',
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    await IPSecurity.logIPActivity(req, 'LOGIN_SUCCESS', user.id, client);

    const deviceContext = createLoginDeviceContext(req, res, { userIp, userAgent });

    await client.query(
      `DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at < NOW()`,
      [user.id]
    );

    await rehashPasswordIfNeeded(client, user.id, user.password_hash, password);

    const loginSession = await createLoginSessionRecord({
      queryable: client,
      user,
      req,
      res,
      userIp,
      userAgent,
      deviceContext,
    });

    await client.query('COMMIT');

    await activateLoginSession(loginSession);

    // Record successful login for trust scoring
    await updateTrustScore(trustDeviceId, 'LOGIN_SUCCESS', req);

    setLoginSessionCookies(req, res, loginSession);

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        profile_id: user.profile_id,
        is_verified: user.is_verified
      },
      device: {
        id: loginSession.deviceId,
        name: loginSession.deviceInfo.deviceName,
        type: loginSession.deviceInfo.deviceType
      }
    });

  } catch (err) {
    if (client) await client.query('ROLLBACK');

    console.error('Login error:', err);
    await IPSecurity.logIPActivity(req, 'LOGIN_ERROR_SERVER');

    let errorMessage = 'An error occurred during login';
    if (err.code === '23505') errorMessage = 'Session conflict detected. Please try again.';

    res.status(500).json({ success: false, message: errorMessage });
  } finally {
    if (client) client.release();
    password = null;
    identifier = null;
  }
});

export default router;
