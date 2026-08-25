import valkey from '../../valkey.js';
import type { SessionMetadata, SessionRecord } from '../types.js';

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days (matches refresh token expiry)

function isSessionRecord(value: unknown): value is SessionRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'userId' in value &&
    typeof value.userId === 'string' &&
    'deviceId' in value &&
    typeof value.deviceId === 'string' &&
    'createdAt' in value &&
    typeof value.createdAt === 'number' &&
    'lastSeenAt' in value &&
    typeof value.lastSeenAt === 'number' &&
    'ip' in value &&
    typeof value.ip === 'string' &&
    'userAgent' in value &&
    typeof value.userAgent === 'string' &&
    'deviceName' in value &&
    typeof value.deviceName === 'string' &&
    'deviceType' in value &&
    typeof value.deviceType === 'string'
  );
}

function parseSession(raw: string): SessionRecord | null {
  const parsed: unknown = JSON.parse(raw);
  return isSessionRecord(parsed) ? parsed : null;
}

/**
 * Valkey-backed session store
 * Works alongside your existing JWT refresh tokens to provide:
 * - Fast session lookups without DB queries
 * - Instant session revocation
 * - Active session tracking per user
 */
export const sessionStore = {
  /**
   * Create/update a session when tokens are issued
   */
  async create(
    userId: string,
    deviceId: string,
    metadata: SessionMetadata = {},
  ): Promise<SessionRecord | null> {
    try {
      const sessionKey = `session:${userId}:${deviceId}`;
      const session = {
        userId,
        deviceId,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        ip: metadata.ip || 'unknown',
        userAgent: metadata.userAgent || 'unknown',
        deviceName: metadata.deviceName || 'Unknown',
        deviceType: metadata.deviceType || 'unknown',
      };

      await valkey.set(sessionKey, JSON.stringify(session), 'EX', SESSION_TTL);

      // Track all sessions for this user
      await valkey.sadd(`user_sessions:${userId}`, deviceId);
      await valkey.expire(`user_sessions:${userId}`, SESSION_TTL);

      return session;
    } catch (err) {
      console.error('Session create error:', err);
      return null;
    }
  },

  /**
   * Quick session validation (used by auth middleware instead of DB query)
   */
  async validate(userId: string, deviceId: string): Promise<SessionRecord | null> {
    try {
      const sessionKey = `session:${userId}:${deviceId}`;
      const raw = await valkey.get(sessionKey);
      if (!raw) return null;

      // Update last seen
      const session = parseSession(raw);
      if (!session) return null;
      session.lastSeenAt = Date.now();
      await valkey.set(sessionKey, JSON.stringify(session), 'EX', SESSION_TTL);

      return session;
    } catch (err) {
      console.error('Session validate error:', err);
      return null;
    }
  },

  /**
   * Revoke a single session (logout from one device)
   */
  async revoke(userId: string, deviceId: string): Promise<boolean> {
    try {
      await valkey.del(`session:${userId}:${deviceId}`);
      await valkey.srem(`user_sessions:${userId}`, deviceId);
      return true;
    } catch (err) {
      console.error('Session revoke error:', err);
      return false;
    }
  },

  /**
   * Revoke all sessions for a user (logout everywhere)
   */
  async revokeAll(userId: string): Promise<boolean> {
    try {
      const deviceIds = await valkey.smembers(`user_sessions:${userId}`);
      if (deviceIds.length > 0) {
        const keys = deviceIds.map((d) => `session:${userId}:${d}`);
        await valkey.del(...keys);
      }
      await valkey.del(`user_sessions:${userId}`);
      return true;
    } catch (err) {
      console.error('Session revokeAll error:', err);
      return false;
    }
  },

  /**
   * Get all active sessions for a user
   */
  async getAll(userId: string): Promise<SessionRecord[]> {
    try {
      const deviceIds = await valkey.smembers(`user_sessions:${userId}`);
      if (deviceIds.length === 0) return [];

      const pipeline = valkey.pipeline();
      deviceIds.forEach((d) => pipeline.get(`session:${userId}:${d}`));
      const results = await pipeline.exec();

      if (!results) return [];

      return results
        .map(([err, raw]) => (
          err || typeof raw !== 'string' ? null : parseSession(raw)
        ))
        .filter((session): session is SessionRecord => session !== null);
    } catch (err) {
      console.error('Session getAll error:', err);
      return [];
    }
  },

  /**
   * Touch session — update last seen without full validation
   */
  async touch(userId: string, deviceId: string): Promise<boolean> {
    try {
      const sessionKey = `session:${userId}:${deviceId}`;
      const raw = await valkey.get(sessionKey);
      if (!raw) return false;

      const session = parseSession(raw);
      if (!session) return false;
      session.lastSeenAt = Date.now();
      await valkey.set(sessionKey, JSON.stringify(session), 'EX', SESSION_TTL);
      return true;
    } catch (err) {
      console.error('Session touch error:', err);
      return false;
    }
  },
};
