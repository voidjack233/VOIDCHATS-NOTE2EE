import type { PoolClient } from 'pg';
import valkey from '../../valkey.js';
import { pool } from '../../db.js';
import type { SessionMetadata, SessionRecord } from '../types.js';

const SESSION_TTL = 30 * 24 * 60 * 60;
const REVOCATION_TTL = 31 * 24 * 60 * 60; // Longer than any token issued for this immutable sid.
const CACHE_DEADLINE_MS = 2_000;
async function boundedCache<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Session cache unavailable')), CACHE_DEADLINE_MS);
    })]);
  } finally { clearTimeout(timer); }
}
const TOUCH_SESSION = `
if redis.call('EXISTS', KEYS[3]) == 1 then return nil end
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local ok, session = pcall(cjson.decode, raw)
if not ok or type(session) ~= 'table' then return nil end
if session.userId ~= ARGV[3] or session.deviceId ~= ARGV[4] or session.sessionId ~= ARGV[5] then return nil end
session.lastSeenAt = tonumber(ARGV[1])
local updated = cjson.encode(session)
redis.call('SET', KEYS[1], updated, 'EX', ARGV[2], 'XX')
redis.call('SADD', KEYS[2], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return updated
`;
const CREATE_SESSION = `
if redis.call('EXISTS', KEYS[3]) == 1 then return nil end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return ARGV[1]
`;
// Called with SQL rows locked. Recovery cannot race past revocation, and
// generation-scoped disconnects cannot close a replacement login.
const INVALIDATE_SESSION = `
if ARGV[1] ~= '' then redis.call('SET', KEYS[3], '1', 'EX', ARGV[4]) end
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, session = pcall(cjson.decode, raw)
  if not ok or type(session) ~= 'table' or not session.sessionId or session.sessionId == ARGV[1] then
    redis.call('DEL', KEYS[1])
    redis.call('SREM', KEYS[2], ARGV[2])
  end
end
return redis.call('PUBLISH', 'void:gateway', ARGV[3])
`;

export interface RevokedSession {
  user_id: string;
  device_id: string;
  session_id: string | null;
  token_hash: string | null;
  previous_token_hash: string | null;
}

function parseSession(raw: string): SessionRecord | null {
  const value = JSON.parse(raw) as Partial<SessionRecord> | null;
  return value && typeof value.userId === 'string' && typeof value.deviceId === 'string' &&
    typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
    typeof value.createdAt === 'number' && typeof value.lastSeenAt === 'number' &&
    typeof value.ip === 'string' && typeof value.userAgent === 'string' &&
    typeof value.deviceName === 'string' && typeof value.deviceType === 'string'
    ? value as SessionRecord : null;
}

async function revokeRecords(
  client: PoolClient,
  userId: string,
  { deviceId, sessionId, exceptDeviceId }: { deviceId?: string; sessionId?: string; exceptDeviceId?: string } = {},
): Promise<RevokedSession[]> {
  // Issuance/revocation always locks the account before its refresh-token rows.
  await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const values = [userId, deviceId ?? null, sessionId ?? null, exceptDeviceId ?? null];
  const predicate = `user_id = $1 AND ($2::text IS NULL OR device_id = $2)
    AND ($3::uuid IS NULL OR session_id = $3)
    AND ($4::text IS NULL OR device_id IS DISTINCT FROM $4)`;
  const result = await client.query<RevokedSession>(
    `SELECT user_id, device_id, session_id, token_hash, previous_token_hash
     FROM refresh_tokens WHERE ${predicate} FOR UPDATE`, values,
  );
  await client.query(
    `UPDATE refresh_tokens SET is_revoked = TRUE, revoked_at = NOW(), revoked_by = $1,
      previous_token_hash = NULL, previous_jti = NULL, previous_valid_until = NULL
     WHERE ${predicate}`, values,
  );
  for (const row of result.rows) {
    if (!row.device_id) continue;
    const subscribers = await boundedCache(valkey.eval(INVALIDATE_SESSION, 3,
      `session:${userId}:${row.device_id}`, `user_sessions:${userId}`, `auth:revoked-session:${row.session_id ?? 'legacy'}`,
      row.session_id ?? '', row.device_id,
      JSON.stringify({ type: 'command', command: 'disconnectSession', data: {
        userId, deviceId: row.device_id, sessionId: row.session_id, code: 4001, reason: 'Session revoked',
      } }), REVOCATION_TTL,
    ));
    // Required publication, not fire-and-forget. Failure aborts the caller's SQL
    // transaction. A tombstoned sid stays denied even on rollback; the user can
    // sign in again with the still-authoritative credentials and a fresh sid.
    if (typeof subscribers !== 'number' || subscribers < 1) {
      throw new Error('Session invalidation unavailable: no gateway subscriber');
    }
  }
  return result.rows;
}

export const sessionStore = {
  // Called after issuance COMMIT. Reuse the now-idle caller client instead of
  // taking another pool slot while the caller still holds the first one.
  async create(userId: string, deviceId: string, sessionId: string, metadata: SessionMetadata = {}, existingClient?: PoolClient): Promise<SessionRecord | null> {
    let client;
    try {
      client = existingClient ?? await pool.connect();
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT created_at FROM refresh_tokens WHERE user_id = $1 AND device_id = $2
         AND session_id = $3 AND is_revoked = FALSE AND expires_at > NOW() FOR SHARE`,
        [userId, deviceId, sessionId],
      );
      if (result.rows.length !== 1) {
        await client.query('ROLLBACK');
        return null;
      }
      const session: SessionRecord = {
        userId, deviceId, sessionId,
        createdAt: new Date(result.rows[0].created_at).getTime(), lastSeenAt: Date.now(),
        ip: metadata.ip || 'unknown', userAgent: metadata.userAgent || 'unknown',
        deviceName: metadata.deviceName || 'Unknown', deviceType: metadata.deviceType || 'unknown',
      };
      // A durable sid fence also rejects an old command delivered after this
      // process/SQL connection dies or a cache deadline releases its row lock.
      const created = await boundedCache(valkey.eval(CREATE_SESSION, 3,
        `session:${userId}:${deviceId}`, `user_sessions:${userId}`, `auth:revoked-session:${sessionId}`,
        JSON.stringify(session), SESSION_TTL, deviceId));
      await client.query('COMMIT');
      return created === null ? null : session;
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      console.error('Session create error:', error);
      return null;
    } finally { if (!existingClient) client?.release(); }
  },

  async validate(userId: string, deviceId: string, sessionId: string): Promise<SessionRecord | null> {
    if (!sessionId) return null;
    try {
      const raw = await boundedCache(valkey.eval(TOUCH_SESSION, 3,
        `session:${userId}:${deviceId}`, `user_sessions:${userId}`, `auth:revoked-session:${sessionId}`,
        Date.now(), SESSION_TTL, userId, deviceId, sessionId));
      return typeof raw === 'string' ? parseSession(raw) : null;
    } catch (error) { console.error('Session validate error:', error); return null; }
  },

  async isRevoked(sessionId: string): Promise<boolean> {
    return await boundedCache(valkey.exists(`auth:revoked-session:${sessionId}`)) !== 0;
  },

  // Requires the caller's open transaction. The index is display-only, never
  // revocation authority, even when incomplete or expired.
  revoke(userId: string, deviceId: string, client: PoolClient, sessionId?: string): Promise<RevokedSession[]> {
    return revokeRecords(client, userId, { deviceId, sessionId });
  },
  revokeAll(userId: string, client: PoolClient, exceptDeviceId?: string): Promise<RevokedSession[]> {
    return revokeRecords(client, userId, { exceptDeviceId });
  },
  async getAll(userId: string): Promise<SessionRecord[]> {
    const deviceIds = await valkey.smembers(`user_sessions:${userId}`);
    if (deviceIds.length === 0) return [];
    const raw = await valkey.mget(...deviceIds.map(d => `session:${userId}:${d}`));
    return raw.flatMap(value => { try { const session = value ? parseSession(value) : null; return session ? [session] : []; } catch { return []; } });
  },
  async touch(userId: string, deviceId: string, sessionId: string): Promise<boolean> {
    return Boolean(await sessionStore.validate(userId, deviceId, sessionId));
  },
};
