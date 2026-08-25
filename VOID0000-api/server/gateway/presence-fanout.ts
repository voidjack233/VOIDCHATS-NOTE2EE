// server/gateway/presence-fanout.js
//
// Subscribes to `void:presence_change` (published by the Phoenix gateway)
// and fans out PRESENCE_UPDATE events to each friend via `void:gateway`.
//
// Flow:
//   Phoenix writes presence to Valkey → publishes {userId, status, lastActive}
//   to void:presence_change → this subscriber picks it up → resolves friend IDs
//   from Postgres → publishes individual PRESENCE_UPDATE events to void:gateway
//   → Phoenix fans out to connected sockets via EventDispatcher.

import { Redis } from 'ioredis';
import { EVENTS } from './protocol.js';
import { debugLog } from '../utils/debugLog.js';
import type { QueryResultRow } from 'pg';

const CHANNEL = 'void:presence_change';

interface FriendIdRow extends QueryResultRow {
  friend_id: string;
}

let subscriber: Redis | null = null;

/**
 * Start the presence-change subscriber.
 * Call once at server startup, after initPublisher().
 */
export function initPresenceFanout(): void {
  if (subscriber) return;

  subscriber = new Redis({
    host: process.env.VALKEY_HOST || '127.0.0.1',
    port: parseInt(process.env.VALKEY_PORT || '6379', 10),
    db: parseInt(process.env.VALKEY_DB || '0', 10),
    maxRetriesPerRequest: 3,
  });

  subscriber.on('connect', () =>
    debugLog(`📡 Presence fanout subscriber connected`)
  );
  subscriber.on('error', (err) =>
    console.error('📡 Presence fanout subscriber error:', err.message)
  );

  subscriber.subscribe(CHANNEL, (err) => {
    if (err) console.error(`📡 Presence fanout subscribe error:`, err);
    else debugLog(`📡 Subscribed to ${CHANNEL}`);
  });

  subscriber.on('message', (channel, raw) => {
    if (channel !== CHANNEL) return;

    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('📡 Presence fanout: invalid JSON');
      return;
    }

    if (typeof msg !== 'object' || msg === null) return;
    const userId = 'userId' in msg ? msg.userId : undefined;
    const status = 'status' in msg ? msg.status : undefined;
    const lastActive = 'lastActive' in msg ? msg.lastActive : undefined;
    if (typeof userId !== 'string' || !userId || typeof status !== 'string' || !status) {
      return;
    }

    handlePresenceChange(userId, status, lastActive);
  });
}

async function handlePresenceChange(
  userId: string,
  status: string,
  lastActive: unknown,
): Promise<void> {
  try {
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

    const data = { user_id: userId, status, last_active: lastActive };

    for (const row of result.rows) {
      publishToGateway(EVENTS.PRESENCE_UPDATE, row.friend_id, data);
    }
  } catch (err) {
    console.error('📡 Presence fanout error:', err);
  }
}
