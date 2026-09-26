import cassandra from 'cassandra-driver';
import { createReactionState } from './state.js';

// Drain all writers for the copy and verification. Legacy tables are retained;
// readiness is published only after both passes succeed.
export async function migrateReactions(db: Pick<cassandra.Client, 'execute'>, apply: boolean) {
  const options = { prepare: true, consistency: cassandra.types.consistencies.localQuorum, fetchSize: 200 };
  const ready = await db.execute("SELECT ready FROM reaction_schema WHERE version='atomic_v1'", [], options);
  if (ready.rows[0]?.ready === true) return { alreadyReady: true, copied: 0, verified: 0 };
  const state = createReactionState(db);
  let copied = 0, verified = 0, pageState: string | undefined;
  do {
    const page: cassandra.types.ResultSet = await db.execute('SELECT conversation_id,message_id,emoji,user_id FROM message_reactions', [], { ...options, pageState });
    for (const row of page.rows) {
      if (apply) await state.set(String(row.conversation_id), String(row.message_id), String(row.user_id), String(row.emoji), true, true);
      copied++;
    }
    pageState = page.pageState;
  } while (pageState);
  if (!apply) return { alreadyReady: false, copied, verified };
  pageState = undefined;
  do {
    const page: cassandra.types.ResultSet = await db.execute('SELECT conversation_id,message_id,emoji,user_id FROM message_reactions', [], { ...options, pageState });
    for (const row of page.rows) {
      const result = await db.execute('SELECT emojis FROM reaction_state WHERE conversation_id=? AND message_id=? AND user_id=?', [row.conversation_id, row.message_id, row.user_id], options);
      if (!result.rows[0]?.emojis?.includes(row.emoji)) throw new Error('Reaction migration membership verification failed');
      verified++;
    }
    pageState = page.pageState;
  } while (pageState);
  let targetRows = 0, key = '', totals: Record<string, number> = {}, expected: Record<string, number> = {};
  const verify = () => {
    if (JSON.stringify(Object.entries(totals).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new Error('Reaction migration count verification failed');
  };
  pageState = undefined;
  do {
    const page: cassandra.types.ResultSet = await db.execute('SELECT conversation_id,message_id,user_id,emojis,counts FROM reaction_state', [], { ...options, pageState });
    for (const row of page.rows) {
      const next = `${row.conversation_id}:${row.message_id}`;
      if (next !== key) { verify(); key = next; totals = {}; expected = row.counts ?? {}; }
      for (const emoji of row.emojis ?? []) { totals[String(emoji)] = (totals[String(emoji)] || 0) + 1; targetRows++; }
    }
    pageState = page.pageState;
  } while (pageState);
  verify();
  if (targetRows !== copied || verified !== copied) throw new Error('Reaction migration changed during copy or target has extra memberships');
  await db.execute("INSERT INTO reaction_schema(version,ready) VALUES('atomic_v1',true)", [], options);
  return { alreadyReady: false, copied, verified };
}
