import { createHash } from 'crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getAccessSecret, getRefreshSecret } from '../config/authSecrets.js';
import type {
  AuthenticatedRequestUser,
  AuthTokenClaims,
  AuthTokenIdentity,
  AuthTokenType,
  TokenPair,
  TokenPairInput,
} from '../types.js';

export const ACCESS_TOKEN_LIFETIME = '15m' as const;
export const REFRESH_TOKEN_LIFETIME = '30d' as const;

export type DecodedAuthToken = string | JwtPayload;

export const hashToken = (token: string): string => (
  createHash('sha256').update(token).digest('hex')
);

export function signAccessToken(
  payload: AuthTokenIdentity,
  jti: string = uuidv4(),
): string {
  return jwt.sign(
    { ...payload, jti, type: 'access' },
    getAccessSecret(),
    { expiresIn: ACCESS_TOKEN_LIFETIME },
  );
}

export function signRefreshToken(
  payload: AuthTokenIdentity,
  jti: string = uuidv4(),
): string {
  return jwt.sign(
    { ...payload, jti, type: 'refresh' },
    getRefreshSecret(),
    { expiresIn: REFRESH_TOKEN_LIFETIME },
  );
}

export function createTokenPair({
  userId,
  profileId,
  deviceId,
  sessionId,
}: TokenPairInput): TokenPair {
  const accessJti = uuidv4();
  const refreshJti = uuidv4();
  const payload = {
    id: userId,
    profile_id: profileId,
    device_id: deviceId,
    sid: sessionId,
  };
  const accessToken = signAccessToken(payload, accessJti);
  const refreshToken = signRefreshToken(payload, refreshJti);

  return {
    accessToken,
    refreshToken,
    accessJti,
    refreshJti,
    refreshTokenHash: hashToken(refreshToken),
  };
}

export function verifyAccessToken(token: string): DecodedAuthToken {
  return jwt.verify(token, getAccessSecret());
}

export function verifyRefreshToken(token: string): DecodedAuthToken {
  return jwt.verify(token, getRefreshSecret());
}

export function decodeAuthToken(token: string): DecodedAuthToken | null {
  return jwt.decode(token);
}

export function hasTokenType(
  decoded: DecodedAuthToken | null,
  expectedType: AuthTokenType,
): decoded is JwtPayload & { type: AuthTokenType } {
  return (
    typeof decoded === 'object' &&
    decoded !== null &&
    decoded.type === expectedType
  );
}

export function isAuthenticatedRequestUser(
  decoded: DecodedAuthToken,
): decoded is AuthenticatedRequestUser {
  return (
    typeof decoded === 'object' &&
    decoded !== null &&
    typeof decoded.id === 'string' &&
    decoded.id.length > 0 &&
    typeof decoded.device_id === 'string' &&
    decoded.device_id.length > 0 &&
    typeof decoded.sid === 'string' && decoded.sid.length > 0 &&
    (decoded.profile_id === undefined || typeof decoded.profile_id === 'string') &&
    (decoded.jti === undefined || typeof decoded.jti === 'string') &&
    decoded.type === 'access'
  );
}

export function isAuthTokenClaims(
  decoded: DecodedAuthToken | null,
  expectedType?: AuthTokenType,
): decoded is AuthTokenClaims {
  return (
    typeof decoded === 'object' &&
    decoded !== null &&
    typeof decoded.id === 'string' &&
    decoded.id.length > 0 &&
    typeof decoded.profile_id === 'string' &&
    decoded.profile_id.length > 0 &&
    typeof decoded.device_id === 'string' &&
    decoded.device_id.length > 0 &&
    typeof decoded.sid === 'string' && decoded.sid.length > 0 &&
    typeof decoded.jti === 'string' &&
    decoded.jti.length > 0 &&
    (decoded.type === 'access' || decoded.type === 'refresh') &&
    (expectedType === undefined || decoded.type === expectedType)
  );
}
