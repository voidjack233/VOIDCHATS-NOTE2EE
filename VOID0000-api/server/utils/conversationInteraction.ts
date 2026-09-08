import type { DatabaseQueryable } from '../db/types.js';

export async function canInteractInConversation(
  db: DatabaseQueryable,
  conversation: { id: string; type: string },
  userId: string,
): Promise<boolean> {
  if (conversation.type !== 'dm') return true;
  const result = await db.query(
    `SELECT dp.conversation_id FROM dm_pairs dp
     JOIN friendships f ON
       ((f.requester_id = dp.user_a AND f.addressee_id = dp.user_b) OR
        (f.requester_id = dp.user_b AND f.addressee_id = dp.user_a))
     WHERE dp.conversation_id = $1 AND $2::uuid IN (dp.user_a, dp.user_b)
       AND f.status = 'accepted' LIMIT 1`,
    [conversation.id, userId],
  );
  return result.rows.length === 1;
}
