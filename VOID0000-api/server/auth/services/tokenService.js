import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getAccessSecret, getRefreshSecret } from '../config/authSecrets.js';

export const ACCESS_TOKEN_LIFETIME = '15m';
export const REFRESH_TOKEN_LIFETIME = '30d';

export const hashToken = (token) => (
  createHash('sha256').update(token).digest('hex')
);

export function signAccessToken(payload, jti = uuidv4()) {
  return jwt.sign(
    { ...payload, jti, type: 'access' },
    getAccessSecret(),
    { expiresIn: ACCESS_TOKEN_LIFETIME },
  );
}

export function signRefreshToken(payload, jti = uuidv4()) {
  return jwt.sign(
    { ...payload, jti, type: 'refresh' },
    getRefreshSecret(),
    { expiresIn: REFRESH_TOKEN_LIFETIME },
  );
}

export function createTokenPair({ userId, profileId, deviceId }) {
  const accessJti = uuidv4();
  const refreshJti = uuidv4();
  const payload = {
    id: userId,
    profile_id: profileId,
    device_id: deviceId,
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

export function verifyAccessToken(token) {
  return jwt.verify(token, getAccessSecret());
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, getRefreshSecret());
}

export function decodeAuthToken(token) {
  return jwt.decode(token);
}

export function hasTokenType(decoded, expectedType) {
  return decoded?.type === expectedType;
}
