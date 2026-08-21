import { publishGatewayCommand } from '../valkey-pubsub.js';

export const PRESENCE_MODES = Object.freeze([
  'online',
  'idle',
  'dnd',
  'invisible',
]);

const PRESENCE_MODE_SET = new Set(PRESENCE_MODES);
const PUBLIC_PRESENCE_STATUSES = new Set(['online', 'idle', 'dnd', 'offline']);
const PRESENCE_MODE_KEY_PREFIX = 'presence_mode:';
const PRESENCE_MODE_TTL_SECONDS = 60 * 60 * 24 * 30;

export function isPresenceMode(value) {
  return typeof value === 'string' && PRESENCE_MODE_SET.has(value);
}

export function normalizePresenceMode(value) {
  // Treat the removed automatic mode as Online during rolling deployments.
  if (value === 'auto') return 'online';
  return isPresenceMode(value) ? value : 'online';
}

export function presenceModeKey(userId) {
  return `${PRESENCE_MODE_KEY_PREFIX}${userId}`;
}

export function normalizePresenceSnapshot(rawPresence, activeCount = 0) {
  if (!rawPresence || typeof rawPresence !== 'object') {
    return {
      status: activeCount > 0 ? 'online' : 'offline',
      lastActive: null,
      activeCount,
    };
  }

  const storedStatus = PUBLIC_PRESENCE_STATUSES.has(rawPresence.status)
    ? rawPresence.status
    : 'online';
  const status = activeCount === 0 ? 'offline' : storedStatus;
  const lastActive = Number.isInteger(rawPresence.lastActive) ? rawPresence.lastActive : null;

  return { status, lastActive, activeCount };
}

export async function cachePresenceMode(userId, mode, redis = null) {
  if (!userId) return false;

  const normalizedMode = normalizePresenceMode(mode);

  try {
    const cache = redis || (await import('../valkey.js')).default;
    await cache.set(
      presenceModeKey(userId),
      normalizedMode,
      'EX',
      PRESENCE_MODE_TTL_SECONDS,
    );
    return true;
  } catch (error) {
    console.error('Presence mode cache update failed:', error);
    return false;
  }
}

export async function persistPresenceMode({
  dbPool,
  userId,
  mode,
  cacheMode = cachePresenceMode,
  publishCommand = publishGatewayCommand,
}) {
  if (!isPresenceMode(mode)) {
    const error = new Error('Invalid presence mode');
    error.code = 'INVALID_PRESENCE_MODE';
    throw error;
  }

  const result = await dbPool.query(
    `INSERT INTO user_preferences (user_id, presence_mode, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       presence_mode = EXCLUDED.presence_mode,
       updated_at = NOW()
     RETURNING presence_mode`,
    [userId, mode],
  );

  const persistedMode = normalizePresenceMode(result.rows[0]?.presence_mode);

  // PostgreSQL is authoritative. Cache/fanout are best-effort and are repaired
  // from bootstrap whenever the user authenticates again.
  await cacheMode(userId, persistedMode);
  publishCommand('updatePresenceMode', { userId, mode: persistedMode });

  return persistedMode;
}
