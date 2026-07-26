import { useCallback, useEffect, useState } from 'react';
import type { Conversation, ConversationMember } from '../../Chat/chatTypes';
import { getConversationDetails } from '../../Chat/conversationCache';
import { gateway } from '../../Gateway/gateway';

interface UseConversationMembersProps {
  activeConversation: Conversation | null;
  activeGroup: Conversation | null;
  userId?: string;
}

interface ConversationMembersState {
  identifier: string | null;
  members: Record<string, ConversationMember>;
}

function getMembershipIdentifier(
  conversation: Conversation | null,
  group: Conversation | null,
): string | null {
  if (!conversation) return null;
  if (conversation.type !== 'channel') return conversation.public_id || conversation.id;
  return (
    conversation.parent_public_id ||
    group?.public_id ||
    conversation.parent_conversation_id ||
    group?.id ||
    null
  );
}

export function useConversationMembers({
  activeConversation,
  activeGroup,
  userId,
}: UseConversationMembersProps) {
  const [refreshedMembers, setRefreshedMembers] = useState<ConversationMembersState>({
    identifier: null,
    members: {},
  });
  const membershipIdentifier = getMembershipIdentifier(activeConversation, activeGroup);
  const cachedDetails = getConversationDetails(membershipIdentifier);
  const cachedMembers = Object.fromEntries(
    (cachedDetails?.members || []).map((member) => [member.user_id, member]),
  );
  const members = refreshedMembers.identifier === membershipIdentifier
    ? refreshedMembers.members
    : cachedMembers;

  useEffect(() => {
    if (!userId || !membershipIdentifier) return;

    const handleNicknameUpdate = (data: { user_id?: unknown; nickname?: unknown }) => {
      const targetUserId = String(data?.user_id || '');
      if (!targetUserId) return;
      const nickname = typeof data?.nickname === 'string' && data.nickname.trim()
        ? data.nickname.trim()
        : null;
      setRefreshedMembers((current) => {
        const currentMembers = current.identifier === membershipIdentifier
          ? current.members
          : Object.fromEntries(
              (getConversationDetails(membershipIdentifier)?.members || [])
                .map((member) => [member.user_id, member]),
            );
        const member = currentMembers[targetUserId];
        if (!member) return current;
        return {
          identifier: membershipIdentifier,
          members: {
            ...currentMembers,
            [targetUserId]: { ...member, nickname },
          },
        };
      });
    };

    gateway.on('MEMBER_NICKNAME_UPDATE', handleNicknameUpdate);
    return () => {
      gateway.off('MEMBER_NICKNAME_UPDATE', handleNicknameUpdate);
    };
  }, [membershipIdentifier, userId]);

  const resetMembers = useCallback(() => {
    setRefreshedMembers({ identifier: null, members: {} });
  }, []);
  return { members, resetMembers };
}
