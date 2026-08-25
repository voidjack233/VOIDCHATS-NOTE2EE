import valkey from '../valkey.js';
import {
  normalizePresenceSnapshot,
  type PresenceSnapshot,
} from './presenceMode.js';
import type { QueryResultRow } from 'pg';

const PRESENCE_KEY_PREFIX = 'presence:';
const PRESENCE_COUNT_KEY_PREFIX = 'presence_count:';
const REACTION_BATCH_WINDOW_MS = 150;
interface ReactionEventPayload {
  event_id?: unknown;
  conversation_id: string;
  conversation_public_id?: unknown;
  message_id: string;
  emoji?: unknown;
  user_id?: unknown;
  action?: unknown;
}

interface QueuedReactionEntry {
  userId: string;
  conversation_id: string;
  conversation_public_id: unknown;
  message_id: string;
  events: Array<Record<string, unknown>>;
  timer: NodeJS.Timeout | null;
}

interface FriendIdRow extends QueryResultRow {
  friend_id: string;
}

const reactionFanoutBuffer = new Map<string, QueuedReactionEntry>();

function presenceKey(userId: string): string {
  return `${PRESENCE_KEY_PREFIX}${userId}`;
}

function presenceCountKey(userId: string): string {
  return `${PRESENCE_COUNT_KEY_PREFIX}${userId}`;
}

function parseSharedActiveCount(rawPresence: unknown, rawCount: unknown): number {
  const parsedCount = Number.parseInt(typeof rawCount === 'string' ? rawCount : '', 10);
  if (Number.isInteger(parsedCount) && parsedCount >= 0) {
    return parsedCount;
  }

  const snapshotCount = typeof rawPresence === 'object' && rawPresence !== null &&
    'activeCount' in rawPresence
    ? rawPresence.activeCount
    : undefined;
  if (
    typeof snapshotCount === 'number' &&
    Number.isInteger(snapshotCount) &&
    snapshotCount >= 0
  ) {
    return snapshotCount;
  }

  return 0;
}

export function sendLiveEventToUser(
  userId: string | null | undefined,
  event: string,
  data: unknown,
): void {
  if (!userId || !event) return;

  void (async () => {
    try {
      const { publishToGateway } = await import('../valkey-pubsub.js');
      publishToGateway(event, userId, data);
    } catch (err) {
      console.error('Gateway user dispatch error:', err);
    }
  })();
}

function reactionBatchKey(userId: string, payload: ReactionEventPayload): string {
  return [
    userId,
    payload?.conversation_id || '',
    payload?.message_id || '',
  ].join(':');
}

export function queueReactionEventToUser(
  userId: string,
  payload: ReactionEventPayload,
): void {
  if (!userId || !payload?.conversation_id || !payload?.message_id) return;

  const key = reactionBatchKey(userId, payload);
  const existing = reactionFanoutBuffer.get(key);

  if (existing) {
    existing.events.push({
      event_id: payload.event_id,
      emoji: payload.emoji,
      user_id: payload.user_id,
      action: payload.action,
    });
    return;
  }

  const entry: QueuedReactionEntry = {
    userId,
    conversation_id: payload.conversation_id,
    conversation_public_id: payload.conversation_public_id || null,
    message_id: payload.message_id,
    events: [{
      event_id: payload.event_id,
      emoji: payload.emoji,
      user_id: payload.user_id,
      action: payload.action,
    }],
    timer: null,
  };

  entry.timer = setTimeout(() => {
    reactionFanoutBuffer.delete(key);
    sendLiveEventToUser(entry.userId, 'REACTIONS_BATCH', {
      conversation_id: entry.conversation_id,
      conversation_public_id: entry.conversation_public_id,
      message_id: entry.message_id,
      events: entry.events,
    });
  }, REACTION_BATCH_WINDOW_MS);

  reactionFanoutBuffer.set(key, entry);
}

export function broadcastLiveEventToFriends(
  userId: string | null | undefined,
  event: string,
  data: unknown,
): void {
  if (!userId || !event) return;

  void (async () => {
    try {
      // Resolve friend IDs in Node so Phoenix receives explicit per-user events
      // and never needs to touch Postgres itself.
      const { publishToGateway } = await import('../valkey-pubsub.js');
      const { pool } = await import('../db.js');

      const result = await pool.query<FriendIdRow>(
        `SELECT CASE WHEN requester_id = $1 THEN addressee_id
                     ELSE requester_id
                END AS friend_id
         FROM friendships
         WHERE (requester_id = $1 OR addressee_id = $1)
           AND status = 'accepted'`,
        [userId]
      );

      for (const row of result.rows) {
        publishToGateway(event, row.friend_id, data);
      }
    } catch (err) {
      console.error('Gateway friend broadcast error:', err);
    }
  })();
}

export async function getLiveUserPresence(
  userId: string | null | undefined,
): Promise<PresenceSnapshot> {
  if (!userId) {
    return { status: 'offline', lastActive: null, activeCount: 0 };
  }

  try {
    const pipeline = valkey.pipeline();
    pipeline.get(presenceKey(userId));
    pipeline.get(presenceCountKey(userId));
    const results = await pipeline.exec();
    const rawPresence = results?.[0]?.[1];
    const rawCount = results?.[1]?.[1];
    const parsedPresence: unknown = typeof rawPresence === 'string'
      ? JSON.parse(rawPresence)
      : null;
    const activeCount = parseSharedActiveCount(parsedPresence, rawCount);

    return normalizePresenceSnapshot(
      parsedPresence,
      activeCount
    );
  } catch (err) {
    console.error('Gateway presence lookup error:', err);
  }

  return { status: 'offline', lastActive: null, activeCount: 0 };
}

/**
 * Bulk presence lookup — single Valkey pipeline instead of N individual calls.
 * Returns a Map<userId, { status, lastActive, activeCount }>.
 */
export async function getBulkUserPresence(
  userIds: readonly string[] | null | undefined,
): Promise<Map<string, PresenceSnapshot>> {
  const result = new Map<string, PresenceSnapshot>();
  if (!userIds || userIds.length === 0) return result;

  const offline: PresenceSnapshot = {
    status: 'offline',
    lastActive: null,
    activeCount: 0,
  };

  try {
    const pipeline = valkey.pipeline();
    for (const userId of userIds) {
      pipeline.get(presenceKey(userId));
      pipeline.get(presenceCountKey(userId));
    }
    const results = await pipeline.exec();

    for (let i = 0; i < userIds.length; i++) {
      const rawPresence = results?.[i * 2]?.[1];
      const rawCount = results?.[i * 2 + 1]?.[1];
      const parsedPresence: unknown = typeof rawPresence === 'string'
        ? JSON.parse(rawPresence)
        : null;
      const activeCount = parseSharedActiveCount(parsedPresence, rawCount);
      result.set(userIds[i], normalizePresenceSnapshot(parsedPresence, activeCount));
    }
  } catch (err) {
    console.error('Gateway bulk presence lookup error:', err);
    for (const userId of userIds) {
      if (!result.has(userId)) result.set(userId, offline);
    }
  }

  return result;
}
