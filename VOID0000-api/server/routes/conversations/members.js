import { Router } from 'express';
import { pool } from '../../db.js';
import { sendLiveEventToUser } from '../../gateway/client.js';
import {
  emitConversationUpdate,
  ensureGroupOwner,
  getChildChannelIds,
  getGroupMembership,
  resolveMembershipConversation,
  uniqueUserIds,
  validateFriendships,
} from '../../utils/groupMembership.js';
import { meetsAdminToggle, resolvePermissions } from '../../utils/groupPermissions.js';
import { registerMemberOwnershipRoutes } from './members/ownership.js';
import { registerMemberRoleRoutes } from './members/roles.js';
import { registerMemberEmitUpdateRoute } from './members/emitUpdate.js';
import { registerConversationNicknameRoutes } from './members/conversationNickname.js';

const router = Router({ mergeParams: true });

const ADMIN_REMOVABLE_TARGET_ROLES = new Set(['member', 'viewer']);

function canRemoveMember({ actorRole, targetRole, actorUserId, targetUserId }) {
  if (actorUserId === targetUserId) {
    return { allowed: true };
  }
  if (targetRole === 'owner') {
    return {
      allowed: false,
      status: 403,
      code: 'OWNER_TRANSFER_REQUIRED',
      error: 'Transfer ownership before removing the owner',
    };
  }
  if (actorRole === 'owner') {
    return { allowed: true };
  }
  if (actorRole === 'admin' && ADMIN_REMOVABLE_TARGET_ROLES.has(targetRole)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    status: 403,
    code: 'TARGET_ROLE_PROTECTED',
    error: 'Admins can only remove regular members',
  };
}

async function getMemberRows(db, conversationId) {
  const result = await db.query(
    `SELECT user_id::text AS user_id, role
     FROM conversation_members
     WHERE conversation_id = $1`,
    [conversationId],
  );
  return result.rows;
}

async function broadcastMembershipUpdate(conversation, memberRows) {
  const memberIds = memberRows.map((row) => row.user_id);
  const memberRolesById = Object.fromEntries(memberRows.map((row) => [row.user_id, row.role]));
  await emitConversationUpdate(conversation, memberIds, memberIds.length, memberRolesById);
}

router.post('/', async (req, res) => {
  const actorUserId = req.user.id;
  const requestedMembers = uniqueUserIds(req.body?.members);

  if (requestedMembers.length === 0) {
    return res.status(400).json({ error: 'Members array required' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const conversation = await resolveMembershipConversation(client, req.params.conversationId);
    if (!conversation) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (conversation.type !== 'group') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot add members to this conversation' });
    }

    const actorMembership = await getGroupMembership(client, conversation.id, actorUserId);
    if (!actorMembership) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not a member' });
    }
    if (!['owner', 'admin'].includes(actorMembership.role)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the owner or an admin can add members' });
    }

    const memberRowsBefore = await getMemberRows(client, conversation.id);
    const currentMemberIds = new Set(memberRowsBefore.map((row) => row.user_id));
    const newMemberIds = requestedMembers.filter((memberId) => !currentMemberIds.has(memberId));
    if (newMemberIds.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'All requested users are already members', code: 'ALREADY_MEMBER' });
    }

    const nonFriendId = await validateFriendships(client, actorUserId, newMemberIds);
    if (nonFriendId) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'You can only add accepted friends to this group',
        code: 'FRIENDSHIP_REQUIRED',
        user_id: nonFriendId,
      });
    }

    const childChannelIds = await getChildChannelIds(client, conversation.id);
    const affectedConversationIds = [conversation.id, ...childChannelIds];
    for (const memberId of newMemberIds) {
      for (const affectedConversationId of affectedConversationIds) {
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT DO NOTHING`,
          [affectedConversationId, memberId],
        );
      }
    }

    await client.query(
      `UPDATE conversations
       SET updated_at = NOW()
       WHERE id = ANY($1::uuid[])`,
      [affectedConversationIds],
    );

    const memberRowsAfter = await getMemberRows(client, conversation.id);

    await client.query('COMMIT');

    await broadcastMembershipUpdate(conversation, memberRowsAfter).catch((emitError) => {
      console.warn('Member add update emit failed:', emitError);
    });

    return res.json({ success: true, added: newMemberIds });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Members POST error:', err);
    return res.status(500).json({ error: 'Failed to add members' });
  } finally {
    client?.release();
  }
});

router.delete('/@me', async (req, res) => {
  const userId = req.user.id;
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const conversation = await resolveMembershipConversation(client, req.params.conversationId);
    if (!conversation) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (conversation.type !== 'group') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Leaving is only supported for groups' });
    }

    const membership = await getGroupMembership(client, conversation.id, userId);
    if (!membership) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not a member' });
    }

    const memberRowsBefore = await getMemberRows(client, conversation.id);
    if (membership.role === 'owner' && memberRowsBefore.length > 1) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'Transfer ownership before leaving this group',
        code: 'OWNER_TRANSFER_REQUIRED',
      });
    }

    const leavePayload = {
      conversation_id: conversation.id,
      conversation_public_id: conversation.public_id ? String(conversation.public_id) : null,
      user_id: userId,
    };

    if (memberRowsBefore.length <= 1) {
      await client.query('DELETE FROM conversations WHERE id = $1', [conversation.id]);
      await client.query('COMMIT');
      sendLiveEventToUser(userId, 'MEMBER_LEAVE', leavePayload);
      return res.json({ success: true, deleted: true, message: 'Group deleted' });
    }

    const childChannelIds = await getChildChannelIds(client, conversation.id);
    const affectedConversationIds = [conversation.id, ...childChannelIds];
    await client.query(
      `DELETE FROM conversation_members
       WHERE conversation_id = ANY($1::uuid[])
         AND user_id = $2`,
      [affectedConversationIds, userId],
    );
    await client.query(
      `UPDATE conversations
       SET updated_at = NOW()
       WHERE id = ANY($1::uuid[])`,
      [affectedConversationIds],
    );

    const ownerState = await ensureGroupOwner(client, conversation.id);
    conversation.owner_id = ownerState.ownerUserId;
    const memberRowsAfter = await getMemberRows(client, conversation.id);

    await client.query('COMMIT');

    sendLiveEventToUser(userId, 'MEMBER_LEAVE', leavePayload);
    await broadcastMembershipUpdate(conversation, memberRowsAfter).catch((emitError) => {
      console.warn('Self-leave survivor update emit failed:', emitError);
    });

    return res.json({ success: true, deleted: false, message: 'Left group' });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Member leave error:', err);
    return res.status(500).json({ error: 'Failed to leave group' });
  } finally {
    client?.release();
  }
});

router.delete('/:targetUserId', async (req, res) => {
  const actorUserId = req.user.id;
  const { targetUserId } = req.params;
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const conversation = await resolveMembershipConversation(client, req.params.conversationId);
    if (!conversation) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (conversation.type !== 'group') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot remove members from this conversation' });
    }

    const actorMembership = await getGroupMembership(client, conversation.id, actorUserId);
    if (!actorMembership) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not a member' });
    }

    const targetResult = await client.query(
      `SELECT role
       FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2
       LIMIT 1`,
      [conversation.id, targetUserId],
    );
    if (targetResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User is not a member' });
    }

    const permissions = resolvePermissions(conversation.permissions);
    if (
      actorUserId !== targetUserId &&
      !meetsAdminToggle(actorMembership.role, permissions.admin_can_remove_members)
    ) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You do not have permission to remove members' });
    }

    const removalAuth = canRemoveMember({
      actorRole: actorMembership.role,
      targetRole: targetResult.rows[0].role,
      actorUserId,
      targetUserId,
    });
    if (!removalAuth.allowed) {
      await client.query('ROLLBACK');
      return res.status(removalAuth.status).json({
        error: removalAuth.error,
        code: removalAuth.code,
      });
    }

    const memberRowsBefore = await getMemberRows(client, conversation.id);
    const remainingMemberIds = memberRowsBefore
      .map((row) => row.user_id)
      .filter((memberId) => memberId !== targetUserId);
    if (remainingMemberIds.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot remove the final group member' });
    }

    const childChannelIds = await getChildChannelIds(client, conversation.id);
    const affectedConversationIds = [conversation.id, ...childChannelIds];
    await client.query(
      `DELETE FROM conversation_members
       WHERE conversation_id = ANY($1::uuid[])
         AND user_id = $2`,
      [affectedConversationIds, targetUserId],
    );
    await client.query(
      `UPDATE conversations
       SET updated_at = NOW()
       WHERE id = ANY($1::uuid[])`,
      [affectedConversationIds],
    );

    const ownerState = await ensureGroupOwner(client, conversation.id);
    conversation.owner_id = ownerState.ownerUserId;
    const memberRowsAfter = await getMemberRows(client, conversation.id);

    await client.query('COMMIT');

    sendLiveEventToUser(targetUserId, 'MEMBER_LEAVE', {
      conversation_id: conversation.id,
      conversation_public_id: conversation.public_id ? String(conversation.public_id) : null,
      removed_by: actorUserId,
    });
    await broadcastMembershipUpdate(conversation, memberRowsAfter).catch((emitError) => {
      console.warn('Member remove update emit failed:', emitError);
    });

    return res.json({ success: true, message: 'Member removed' });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Members DELETE error:', err);
    return res.status(500).json({ error: 'Failed to remove member' });
  } finally {
    client?.release();
  }
});

registerMemberOwnershipRoutes(router);
registerMemberRoleRoutes(router);
registerMemberEmitUpdateRoute(router);
registerConversationNicknameRoutes(router);

export default router;
