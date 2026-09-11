import { Router, type Request, type RequestHandler } from 'express';
import { pool } from '../../db.js';
import { sessionStore } from '../services/sessionService.js';
import {
  isAuthenticatedRequestUser,
  verifyAccessToken,
} from '../services/tokenService.js';
import type { AuthenticatedRequestUser } from '../types.js';
import { matchesRequestAccount, accountChangedResponse } from './requestAccount.js';

const router = Router();

interface SessionRecoveryRow {
  ip_address: string | null;
  user_agent: string | null;
  device_name: string | null;
  device_type: string | null;
}

interface VerificationFailure {
  ok: false;
  status: number;
  body: { error: string; code?: string };
}

interface VerificationSuccess {
  ok: true;
  user: AuthenticatedRequestUser;
}

type VerificationResult = VerificationFailure | VerificationSuccess;

export function requireAuthenticatedUser(req: Request): AuthenticatedRequestUser {
  if (!req.user) {
    throw new Error('Authenticated route is missing request user context');
  }
  return req.user;
}

async function verifyRequestSession(req: Request): Promise<VerificationResult> {
  const token = typeof req.cookies?.accessToken === 'string'
    ? req.cookies.accessToken
    : null;

  if (!token) {
    return { ok: false, status: 401, body: { error: 'Authentication required' } };
  }

  try {
    const decoded = verifyAccessToken(token);
    if (!isAuthenticatedRequestUser(decoded)) {
      return { ok: false, status: 401, body: { error: 'Token invalid or expired' } };
    }
    if (!matchesRequestAccount(req, decoded.id)) {
      return { ok: false, status: 409, body: accountChangedResponse };
    }

    let session = await sessionStore.validate(decoded.id, decoded.device_id, decoded.sid);

    if (!session) {
      const result = await pool.query<SessionRecoveryRow>(
        `SELECT ip_address, user_agent, device_name, device_type
         FROM refresh_tokens
         WHERE user_id = $1
           AND device_id = $2
           AND is_revoked = FALSE
           AND expires_at > NOW()
           AND session_id = $3
         ORDER BY last_used_at DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [decoded.id, decoded.device_id, decoded.sid]
      );

      if (result.rows.length === 0) {
        return { ok: false, status: 401, body: { error: 'Session invalid or revoked' } };
      }

      const activeSession = result.rows[0];
      session = await sessionStore.create(decoded.id, decoded.device_id, decoded.sid, {
        ip: activeSession.ip_address || 'unknown',
        userAgent: activeSession.user_agent || 'unknown',
        deviceName: activeSession.device_name || 'Unknown',
        deviceType: activeSession.device_type || 'unknown',
      });

      if (!session) {
        return { ok: false, status: 500, body: { error: 'Session validation failed' } };
      }
    }

    return { ok: true, user: decoded };
  } catch {
    return { ok: false, status: 401, body: { error: 'Token invalid or expired' } };
  }
}

export const authenticateUser: RequestHandler = async (req, res, next) => {
  const result = await verifyRequestSession(req);

  if (!result.ok) {
    res.status(result.status).json(result.body);
    return;
  }

  req.user = result.user;
  next();
};

// API ENDPOINT
router.get('/', async (req, res) => {
  const result = await verifyRequestSession(req);

  if (!result.ok) {
    return res.status(result.status).json({
      success: false,
      message: result.body.error,
    });
  }

  res.json({ success: true, user: result.user });
});

export default router;
