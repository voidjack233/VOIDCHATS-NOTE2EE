import type { Request, Response } from 'express';

import { DeviceManager, getClientIP } from '../../utils/securityUtils.js';
import type { DatabaseQueryable } from '../../db/types.js';
import {
  accessCookieOptions,
  refreshCookieOptions,
} from '../config/authCookies.js';
import { createTokenPair } from './tokenService.js';
import { sessionStore } from './sessionService.js';
import type { SessionRecord, TokenPair } from '../types.js';

interface DeviceInfo {
  deviceName: string;
  deviceType: string;
}

interface LoginDeviceContext {
  deviceId: string;
  deviceInfo: DeviceInfo;
  userIp: string | null;
  userAgent: string;
}

interface LoginUser {
  id: string;
  profile_id: string;
}

interface LoginSessionRecord extends TokenPair, LoginDeviceContext {
  userId: string;
}

interface LoginDeviceOptions {
  userIp?: string | null;
  userAgent?: string;
}

interface CreateLoginSessionOptions extends LoginDeviceOptions {
  queryable: DatabaseQueryable;
  user: LoginUser;
  req: Request;
  res: Response;
  deviceContext?: LoginDeviceContext;
}

function normalizeIP(ip: string | null | undefined): string | null {
  if (!ip) return null;
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
}

export function createLoginDeviceContext(
  req: Request,
  res: Response,
  {
    userIp = normalizeIP(getClientIP(req)),
    userAgent = req.get('User-Agent') || 'unknown',
  }: LoginDeviceOptions = {},
): LoginDeviceContext {
  const generatedDeviceId: unknown = DeviceManager.generateDeviceId(req, res);
  const generatedDeviceInfo: unknown = DeviceManager.getDeviceInfo(req);
  if (
    typeof generatedDeviceId !== 'string' ||
    typeof generatedDeviceInfo !== 'object' ||
    generatedDeviceInfo === null ||
    !('deviceName' in generatedDeviceInfo) ||
    typeof generatedDeviceInfo.deviceName !== 'string' ||
    !('deviceType' in generatedDeviceInfo) ||
    typeof generatedDeviceInfo.deviceType !== 'string'
  ) {
    throw new Error('Device identity generation returned an invalid result');
  }

  return {
    deviceId: generatedDeviceId,
    deviceInfo: {
      deviceName: generatedDeviceInfo.deviceName,
      deviceType: generatedDeviceInfo.deviceType,
    },
    userIp,
    userAgent,
  };
}

export async function createLoginSessionRecord({
  queryable,
  user,
  req,
  res,
  userIp = normalizeIP(getClientIP(req)),
  userAgent = req.get('User-Agent') || 'unknown',
  deviceContext = createLoginDeviceContext(req, res, { userIp, userAgent }),
}: CreateLoginSessionOptions): Promise<LoginSessionRecord> {
  const { deviceId, deviceInfo } = deviceContext;
  const tokens = createTokenPair({
    userId: user.id,
    profileId: user.profile_id,
    deviceId,
  });

  await queryable.query(
    `INSERT INTO refresh_tokens
      (user_id, token_hash, jti, expires_at, ip_address, user_agent, device_id, device_name, device_type, last_used_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', $4, $5, $6, $7, $8, NOW())
     ON CONFLICT ON CONSTRAINT unique_user_device
     DO UPDATE SET
       token_hash = EXCLUDED.token_hash,
       jti = EXCLUDED.jti,
       previous_token_hash = NULL,
       previous_jti = NULL,
       previous_valid_until = NULL,
       expires_at = EXCLUDED.expires_at,
       ip_address = EXCLUDED.ip_address,
       user_agent = EXCLUDED.user_agent,
       device_name = EXCLUDED.device_name,
       device_type = EXCLUDED.device_type,
       is_revoked = FALSE,
       revoked_at = NULL,
       revoked_by = NULL,
       last_used_at = NOW(),
       created_at = NOW()`,
    [
      user.id,
      tokens.refreshTokenHash,
      tokens.refreshJti,
      userIp,
      userAgent,
      deviceId,
      deviceInfo.deviceName,
      deviceInfo.deviceType,
    ],
  );

  return {
    userId: user.id,
    deviceId,
    deviceInfo,
    userIp: deviceContext.userIp,
    userAgent: deviceContext.userAgent,
    ...tokens,
  };
}

export function activateLoginSession(
  session: LoginSessionRecord,
): Promise<SessionRecord | null> {
  return sessionStore.create(session.userId, session.deviceId, {
    ip: session.userIp,
    userAgent: session.userAgent,
    deviceName: session.deviceInfo.deviceName,
    deviceType: session.deviceInfo.deviceType,
  });
}

export function setLoginSessionCookies(
  req: Request,
  res: Response,
  session: LoginSessionRecord,
): void {
  res.cookie('accessToken', session.accessToken, accessCookieOptions(req));
  res.cookie('refreshToken', session.refreshToken, refreshCookieOptions(req));
}
