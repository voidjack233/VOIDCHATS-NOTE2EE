import type { PoolClient } from 'pg';
import { sessionStore } from './sessionService.js';
import valkey from '../../valkey.js';

// Inside the credential-change transaction, before COMMIT/replacement issuance.
// Required invalidation failure must abort the credential change.
export async function revokeCredentialRecords(db: PoolClient, userId: string): Promise<void> {
  await sessionStore.revokeAll(userId, db);
  await db.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
  await valkey.del(`auth:2fa:action-email:${userId}:change_password`);
}
