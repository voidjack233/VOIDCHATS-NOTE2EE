import cassandra from 'cassandra-driver';
import { createReactionState } from '../../../server/reactions/state.js';
const [keyspace, conversation, message, user, emoji] = process.argv.slice(2);
if (!/^void_reaction_audit_[a-f0-9]{32}$/.test(keyspace)) throw new Error('Disposable audit keyspace required');
const db = new cassandra.Client({ contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1', keyspace });
await db.connect();
process.send?.({ ready: true });
process.once('message', async () => {
  try { process.send?.({ result: await createReactionState(db).set(conversation, message, user, emoji, true) }); }
  catch (error) { process.send?.({ error: error.code || error.message }); }
  finally { await db.shutdown(); process.disconnect?.(); }
});
