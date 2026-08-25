import { publishGatewayCommand } from '../valkey-pubsub.js';
import type { DatabaseQueryable } from '../db/types.js';

export const PRESENCE_MODES = Object.freeze([
  'online',
  'idle',
  'dnd',
  'invisible',
] as const);

export type PresenceMode = typeof PRESENCE_MODES[number];
export type PublicPresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

export interface PresenceSnapshot {
  status: PublicPresenceStatus;
  lastActive: number | null;
  activeCount: number;
}

interface PresenceCache {
  set(...args: Array<string | number>): Promise<unknown>;
}

interface PersistPresenceModeOptions {
  dbPool: DatabaseQueryable;
  userId: string;
  mode: unknown;
  cacheMode?: (
    userId: string,
    mode: PresenceMode,
  ) => Promise<boolean>;
  publishCommand?: (
    command: string,
    payload: Record<string, unknown>,
  ) => unknown;
}

const PRESENCE_MODE_SET: ReadonlySet<string> = new Set(PRESENCE_MODES);
const PUBLIC_PRESENCE_STATUSES = new Set(['online', 'idle', 'dnd', 'offline']);
const PRESENCE_MODE_KEY_PREFIX = 'presence_mode:';
const PRESENCE_MODE_TTL_SECONDS = 60 * 60 * 24 * 30;

export function isPresenceMode(value: unknown): value is PresenceMode {
  return typeof value === 'string' && PRESENCE_MODE_SET.has(value);
}

export function normalizePresenceMode(value: unknown): PresenceMode {
  // Treat the removed automatic mode as Online during rolling deployments.
  if (value === 'auto') return 'online';
  return isPresenceMode(value) ? value : 'online';
}

export function presenceModeKey(userId: unknown): string {
  return `${PRESENCE_MODE_KEY_PREFIX}${userId}`;
}

export function normalizePresenceSnapshot(
  rawPresence: unknown,
  activeCount: number = 0,
): PresenceSnapshot {
  if (!rawPresence || typeof rawPresence !== 'object') {
    return {
      status: activeCount > 0 ? 'online' : 'offline',
      lastActive: null,
      activeCount,
    };
  }

  const rawStatus = 'status' in rawPresence ? rawPresence.status : undefined;
  const rawLastActive = 'lastActive' in rawPresence
    ? rawPresence.lastActive
    : undefined;
  const storedStatus: PublicPresenceStatus = (
    typeof rawStatus === 'string' && PUBLIC_PRESENCE_STATUSES.has(rawStatus)
  )
    ? rawStatus as PublicPresenceStatus
    : 'online';
  const status = activeCount === 0 ? 'offline' : storedStatus;
  const lastActive = typeof rawLastActive === 'number' && Number.isInteger(rawLastActive)
    ? rawLastActive
    : null;

  return { status, lastActive, activeCount };
}

export async function cachePresenceMode(
  userId: string,
  mode: unknown,
  redis: PresenceCache | null = null,
): Promise<boolean> {
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
}: PersistPresenceModeOptions): Promise<PresenceMode> {
  if (!isPresenceMode(mode)) {
    throw Object.assign(new Error('Invalid presence mode'), {
      code: 'INVALID_PRESENCE_MODE',
    });
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
