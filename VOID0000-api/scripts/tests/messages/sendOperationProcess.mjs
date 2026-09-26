import pg from 'pg';
import { claimMessageSend } from '../../../server/routes/conversations/messages/sendOperation.js';

process.once('message', async options => {
  const pool = new pg.Pool({ max: 1 });
  try {
    const claim = await claimMessageSend({ ...options, dbPool: pool, restoreLegacy: async () => null });
    process.send({ messageId: claim.row.message_id });
    process.once('disconnect', async () => { await claim.close(); await pool.end(); });
  } catch (error) { process.send({ error: error.message }); await pool.end(); process.disconnect(); }
});
