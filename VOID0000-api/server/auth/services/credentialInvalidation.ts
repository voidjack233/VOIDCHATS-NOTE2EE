import type { DatabaseQueryable } from '../../db/types.js';
import { sessionStore } from './sessionService.js';
import valkey from '../../valkey.js';
import { disconnectLiveSession } from '../../gateway/control.js';

export async function revokeCredentialRecords(db: DatabaseQueryable, userId: string): Promise<void> {
  await db.query(
    `UPDATE refresh_tokens SET is_revoked = TRUE, revoked_at = NOW(), revoked_by = $1,
      previous_token_hash = NULL, previous_jti = NULL, previous_valid_until = NULL
     WHERE user_id = $1 AND is_revoked = FALSE`, [userId],
  );
  await db.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
}

export async function invalidateCredentialSessions(userId: string): Promise<void> {
  const revoked = await sessionStore.revokeAll(userId);
  await disconnectLiveSession(userId, null, 4001, 'Password changed');
  await valkey.del(`auth:2fa:action-email:${userId}:change_password`);
  if (!revoked) throw new Error('Credential session invalidation unavailable');
}
