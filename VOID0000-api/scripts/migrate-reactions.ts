import scylla from '../server/scylla.js';
import { migrateReactions } from '../server/reactions/migrate.js';

try {
  const apply = process.argv.includes('--apply');
  if (apply && !process.argv.includes('--writers-stopped')) throw new Error('Stop ALL old/new reaction writers, then pass --apply --writers-stopped');
  console.log(JSON.stringify(await migrateReactions(scylla, apply), null, 2));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await scylla.shutdown(); }
