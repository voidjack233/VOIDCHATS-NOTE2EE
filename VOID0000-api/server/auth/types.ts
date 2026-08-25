import type { JwtPayload } from 'jsonwebtoken';

export type AuthTokenType = 'access' | 'refresh';

export interface AuthTokenIdentity {
  id: string;
  profile_id: string;
  device_id: string;
}

export interface AuthTokenClaims extends JwtPayload, AuthTokenIdentity {
  jti: string;
  type: AuthTokenType;
}

export interface AuthenticatedRequestUser extends JwtPayload {
  id: string;
  device_id: string;
  profile_id?: string;
  jti?: string;
  type?: AuthTokenType;
}

export interface TokenPairInput {
  userId: string;
  profileId: string;
  deviceId: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessJti: string;
  refreshJti: string;
  refreshTokenHash: string;
}

export interface SessionMetadata {
  ip?: string | null;
  userAgent?: string | null;
  deviceName?: string | null;
  deviceType?: string | null;
}

export interface SessionRecord {
  userId: string;
  deviceId: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string;
  userAgent: string;
  deviceName: string;
  deviceType: string;
}

export type PrimaryTwoFactorMethod = 'totp' | 'email';
export type TwoFactorMethod = PrimaryTwoFactorMethod | 'backup';

export interface PendingTwoFactorSession {
  userId: string;
  allowedMethods: readonly TwoFactorMethod[];
  deviceFingerprint?: string;
  userAgent?: string;
  ip?: string | null;
  expiresAt?: number;
  emailCodeHash?: string;
  [key: string]: unknown;
}
