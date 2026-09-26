import cassandra from 'cassandra-driver';
import { setTimeout as delay } from 'node:timers/promises';

type Store = Pick<cassandra.Client, 'execute'>;
const quorum = { prepare: true, consistency: cassandra.types.consistencies.localQuorum };
const conditional = { ...quorum, serialConsistency: cassandra.types.consistencies.localSerial, isIdempotent: false };
const SUMMARY_USER = cassandra.types.Uuid.fromString('00000000-0000-0000-0000-000000000000');
export const MAX_UNIQUE_REACTIONS = 10;

export class ReactionError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface ReactionSnapshot {
  counts: Record<string, number>;
  revision: string;
  mine: string[];
}

// This only avoids local Paxos contention; the conditional batch is the
// cross-process authority. Pending requests have not been acknowledged durable.
class MessageQueue {
  private tails = new Map<string, Promise<void>>();
  private sizes = new Map<string, number>();
  private pending = 0;
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (this.pending >= 1024 || (this.sizes.get(key) || 0) >= 512) {
      throw new ReactionError(425, 'REACTION_BUSY', 'Reaction queue is busy');
    }
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    this.sizes.set(key, (this.sizes.get(key) || 0) + 1);
    this.pending++;
    const queuedAt = Date.now();
    try {
      await previous;
      if (Date.now() - queuedAt > 5000) throw new ReactionError(425, 'REACTION_BUSY', 'Reaction queue wait expired');
      return await task();
    } finally {
      release(); this.pending--;
      const remaining = (this.sizes.get(key) || 1) - 1;
      if (remaining) this.sizes.set(key, remaining); else this.sizes.delete(key);
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export function createReactionState(db: Store) {
  const queue = new MessageQueue();
  let ready: Promise<void> | undefined;
  function ensureReady(): Promise<void> {
    ready ??= db.execute("SELECT ready FROM reaction_schema WHERE version='atomic_v1'", [], quorum).then(result => {
      if (result.rows[0]?.ready !== true) throw new ReactionError(503, 'REACTIONS_NOT_READY', 'Reaction migration is not complete');
    }).catch(error => { ready = undefined; throw error; });
    return ready;
  }

  async function read(conversation: cassandra.types.Uuid, message: cassandra.types.TimeUuid, user: cassandra.types.Uuid) {
    // Complete an outstanding Paxos decision before returning an idempotent
    // no-op after an ambiguous timeout; an ordinary quorum read is insufficient.
    const membership = await db.execute('SELECT counts,revision,user_id,emojis FROM reaction_state WHERE conversation_id=? AND message_id=? AND user_id IN ?', [conversation, message, [SUMMARY_USER, user]], { ...quorum, consistency: cassandra.types.consistencies.localSerial });
    const row = membership.rows[0];
    const revision = row?.revision as cassandra.types.Long | undefined;
    const counts = { ...(row?.counts as Record<string, number> | null ?? {}) };
    if (Object.values(counts).some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error('Invalid stored reaction summary');
    const mine = (membership.rows.find(r => String(r.user_id) === String(user))?.emojis ?? []) as string[];
    const consistent = membership.rows.every(r => String(r.revision) === String(revision));
    return { counts, revision, mine, consistent };
  }

  async function set(conversationId: string, messageId: string, userId: string, emoji: string, present: boolean, migrating = false) {
    if (!migrating) await ensureReady();
    return queue.run(`${conversationId}:${messageId}`, async () => {
      const conversation = cassandra.types.Uuid.fromString(conversationId), message = cassandra.types.TimeUuid.fromString(messageId), user = cassandra.types.Uuid.fromString(userId);
      for (let attempt = 0; attempt < 8; attempt++) {
        const state = await read(conversation, message, user);
        const existing = state.mine.includes(emoji);
        if (state.consistent) {
          if (existing === present) return { ...state, revision: String(state.revision ?? 0), changed: false };
          if (present && !state.counts[emoji] && Object.keys(state.counts).length >= MAX_UNIQUE_REACTIONS) {
            throw new ReactionError(409, 'REACTION_LIMIT_REACHED', `Maximum of ${MAX_UNIQUE_REACTIONS} reactions per message`);
          }
          const counts = { ...state.counts }, nextCount = (counts[emoji] || 0) + (present ? 1 : -1);
          if (nextCount < 0) throw new Error('Reaction membership has no summary');
          if (nextCount) counts[emoji] = nextCount; else delete counts[emoji];
          const revision = (state.revision ?? cassandra.types.Long.ZERO).add(cassandra.types.Long.ONE);
          const mine = present ? [...state.mine, emoji] : state.mine.filter(e => e !== emoji);
          const mutation = mine.length
            ? 'UPDATE reaction_state SET emojis=? WHERE conversation_id=? AND message_id=? AND user_id=?;'
            : 'DELETE FROM reaction_state WHERE conversation_id=? AND message_id=? AND user_id=?;';
          const membershipParams = mine.length ? [mine, conversation, message, user] : [conversation, message, user];
          // Summary and membership share ONE partition and one Paxos decision.
          // Never mix non-conditional writes or counter deltas into this table.
          const result = await db.execute(`BEGIN BATCH
            UPDATE reaction_state SET counts=?,revision=? WHERE conversation_id=? AND message_id=? IF revision=?;
            ${mutation}
            INSERT INTO reaction_state(conversation_id,message_id,user_id,emojis) VALUES(?,?,?,{});
            APPLY BATCH`, [counts, revision, conversation, message, state.revision ?? null, ...membershipParams, conversation, message, SUMMARY_USER], conditional);
          if (result.wasApplied()) return { counts, revision: revision.toString(), mine, changed: true };
        }
        await delay(5 + Math.random() * Math.min(160, 10 * 2 ** attempt));
      }
      throw new ReactionError(425, 'REACTION_BUSY', 'Concurrent reaction changed; retry desired state');
    });
  }

  async function batch(conversationId: string, messageIds: readonly string[], userId?: string | null,
    time: <T>(stage: 'reaction_counts' | 'user_reactions', work: () => Promise<T>) => Promise<T> = (_stage, work) => work()) {
    if (!messageIds.length) return { reactions: {}, revisions: {} };
    await ensureReady();
    const conversation = cassandra.types.Uuid.fromString(conversationId);
    const output: Record<string, Record<string, { count: number; me: boolean; revision: string }>> = {};
    const revisions: Record<string, string> = {};
    for (let offset = 0; offset < messageIds.length; offset += 50) {
      const ids = messageIds.slice(offset, offset + 50).map(id => cassandra.types.TimeUuid.fromString(id));
      // The permanent summary row ensures a non-reacting user still receives
      // counts. One partition snapshot now contains both counts and `me`;
      // only two rows (summary + this user's bounded emoji set) per message.
      const users = userId ? [SUMMARY_USER, cassandra.types.Uuid.fromString(userId)] : [SUMMARY_USER];
      const members = await time('reaction_counts', () => db.execute('SELECT message_id,user_id,emojis,revision,counts FROM reaction_state WHERE conversation_id=? AND message_id IN ? AND user_id IN ?', [conversation, ids, users], quorum));
      const mine = new Map<string, Set<string>>(), states = new Map<string, cassandra.types.Row>();
      for (const row of members.rows) {
        const id = String(row.message_id);
        if (!mine.has(id)) mine.set(id, new Set());
        if (String(row.user_id) === userId) for (const emoji of row.emojis ?? []) mine.get(id)?.add(String(emoji));
        states.set(id, row);
      }
      for (const id of messageIds.slice(offset, offset + 50)) {
        const row = states.get(id), counts = row?.counts as Record<string, number> | null;
        revisions[id] = String(row?.revision ?? 0);
        output[id] = Object.fromEntries(Object.entries(counts ?? {}).filter(([, count]) => count > 0).map(([emoji, count]) => [emoji, { count, me: mine.get(id)?.has(emoji) ?? false, revision: String(row?.revision ?? 0) }]));
      }
    }
    return { reactions: output, revisions };
  }
  return { set, batch, ensureReady };
}
