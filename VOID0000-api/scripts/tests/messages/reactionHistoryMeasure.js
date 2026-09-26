import assert from 'node:assert/strict';
import cassandra from 'cassandra-driver';
import { performance } from 'node:perf_hooks';
import { createReactionState } from '../../../server/reactions/state.js';

export async function measureReactionHistory(db) {
  const conversation = cassandra.types.Uuid.random(), user = cassandra.types.Uuid.random(), state = createReactionState(db);
  const ids = Array.from({ length: 50 }, () => cassandra.types.TimeUuid.now());
  const options = { prepare: true, consistency: cassandra.types.consistencies.localQuorum };
  for (const message of ids) for (const emoji of ['a', 'b', 'c', 'd', 'e', 'f']) {
    await db.execute('UPDATE reaction_counts SET count=count+1 WHERE conversation_id=? AND message_id=? AND emoji=?', [conversation, message, emoji], options);
    await db.execute('INSERT INTO user_reactions(conversation_id,user_id,message_id,emoji) VALUES(?,?,?,?)', [conversation, user, message, emoji], options);
    await state.set(String(conversation), String(message), String(user), emoji, true);
  }
  const results = [];
  for (const size of [20, 50]) {
    const messages = ids.slice(0, size), baseline = [], replacement = [];
    for (let i = 0; i < 105; i++) {
      let oldResult, next;
      for (const variant of i % 2 ? ['baseline', 'replacement'] : ['replacement', 'baseline']) {
        const start = performance.now();
        if (variant === 'baseline') {
          const [counts, mine] = await Promise.all([
            db.execute('SELECT message_id,emoji,count FROM reaction_counts WHERE conversation_id=? AND message_id IN ?', [conversation, messages], options),
            db.execute('SELECT message_id,emoji FROM user_reactions WHERE conversation_id=? AND user_id=? AND message_id IN ?', [conversation, user, messages], options),
          ]);
          // Include the legacy mapping work, as for the replacement path.
          const me = new Set(mine.rows.map(row => `${row.message_id}:${row.emoji}`));
          oldResult = Object.fromEntries(messages.map(id => [String(id), {}]));
          for (const row of counts.rows) if (row.count.toNumber() > 0) oldResult[String(row.message_id)][row.emoji] = { count: row.count.toNumber(), me: me.has(`${row.message_id}:${row.emoji}`) };
        } else next = await state.batch(String(conversation), messages.map(String), String(user));
        const elapsed = performance.now() - start;
        if (i >= 5) (variant === 'baseline' ? baseline : replacement).push(elapsed);
      }
      for (const message of messages) {
        assert.equal(Object.keys(next.reactions[String(message)]).length, 6);
        const withoutVersion = Object.fromEntries(Object.entries(next.reactions[String(message)]).map(([e, r]) => [e, { count: r.count, me: r.me }]));
        assert.deepEqual(withoutVersion, oldResult[String(message)]);
      }
    }
    results.push({ size, samples: 100, baseline, replacement });
  }
  return results;
}
