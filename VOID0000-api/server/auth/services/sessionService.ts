import valkey from '../../valkey.js';
import { pool } from '../../db.js';
import type { SessionMetadata, SessionRecord } from '../types.js';

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days (matches refresh token expiry)

const TOUCH_SESSION = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local ok, session = pcall(cjson.decode, raw)
if not ok or type(session) ~= 'table' then return nil end
if session.userId ~= ARGV[3] or session.deviceId ~= ARGV[4] then return nil end
session.lastSeenAt = tonumber(ARGV[1])
local updated = cjson.encode(session)
redis.call('SET', KEYS[1], updated, 'EX', ARGV[2], 'XX')
return updated
`;

const CREATE_SESSION = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return ARGV[1]
`;

const REVOKE_SESSION = `
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
return 1
`;

const REVOKE_ALL_SESSIONS = `
local devices = redis.call('SMEMBERS', KEYS[1])
for _, device in ipairs(devices) do
  redis.call('DEL', ARGV[1] .. device)
end
redis.call('DEL', KEYS[1])
return 1
`;

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
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // Hold the authoritative row through cache creation. Revocation's UPDATE
      // must finish after this write, or this read must observe the revocation.
      const result = await client.query(
        `SELECT created_at FROM refresh_tokens
         WHERE user_id = $1 AND device_id = $2
           AND is_revoked = FALSE AND expires_at > NOW()
         FOR SHARE`, [userId, deviceId],
      );
      if (result.rows.length !== 1) {
        await client.query('ROLLBACK');
        return null;
      }
      const sessionKey = `session:${userId}:${deviceId}`;
      const session = {
        userId,
        deviceId,
        createdAt: new Date(result.rows[0].created_at).getTime(),
        lastSeenAt: Date.now(),
        ip: metadata.ip || 'unknown',
        userAgent: metadata.userAgent || 'unknown',
        deviceName: metadata.deviceName || 'Unknown',
        deviceType: metadata.deviceType || 'unknown',
      };

      await valkey.eval(CREATE_SESSION, 2, sessionKey, `user_sessions:${userId}`,
        JSON.stringify(session), SESSION_TTL, deviceId);
      await client.query('COMMIT');
      return session;
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      console.error('Session create error:', err);
      return null;
    } finally { client?.release(); }
  },

  /**
   * Quick session validation (used by auth middleware instead of DB query)
   */
  async validate(userId: string, deviceId: string): Promise<SessionRecord | null> {
    try {
      const sessionKey = `session:${userId}:${deviceId}`;
      const raw = await valkey.eval(TOUCH_SESSION, 1, sessionKey, Date.now(), SESSION_TTL, userId, deviceId);
      return typeof raw === 'string' ? parseSession(raw) : null;
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
      await valkey.eval(REVOKE_SESSION, 2, `session:${userId}:${deviceId}`, `user_sessions:${userId}`, deviceId);
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
      await valkey.eval(REVOKE_ALL_SESSIONS, 1, `user_sessions:${userId}`, `session:${userId}:`);
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
    return Boolean(await sessionStore.validate(userId, deviceId));
  },
};
