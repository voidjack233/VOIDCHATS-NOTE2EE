import { useCallback, useEffect, useState } from 'react';
import { getConversation } from '../../Chat/conversationService';
import type { Conversation, ConversationDetails, ConversationMember } from '../../Chat/chatTypes';
import {
  areConversationDetailsFresh,
  getConversationDetails,
  requestConversationDetails,
} from '../../Chat/conversationCache';
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

  const refreshMembers = useCallback(async () => {
    if (!membershipIdentifier) {
      return;
    }

    const cached = getConversationDetails(membershipIdentifier);
    if (cached && areConversationDetailsFresh(membershipIdentifier, 1_500, userId || 'anonymous')) {
      return;
    }

    const requestedIdentifier = membershipIdentifier;
    const details = await requestConversationDetails(requestedIdentifier, async () => {
      const data = await getConversation(requestedIdentifier);
      return data.conversation as ConversationDetails;
    }, userId || 'anonymous');
    const nextMembers = details.members || [];
    setRefreshedMembers({
      identifier: requestedIdentifier,
      members: Object.fromEntries(nextMembers.map((member) => [member.user_id, member])),
    });
  }, [membershipIdentifier, userId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refreshMembers().catch((error) => {
        console.warn('Failed to refresh conversation members:', error);
      });
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [refreshMembers]);

  useEffect(() => {
    if (!userId || !membershipIdentifier) return;

    const handleConversationUpdate = () => {
      void refreshMembers().catch(() => {});
    };
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

    gateway.on('CONVERSATION_UPDATE', handleConversationUpdate);
    gateway.on('MEMBER_NICKNAME_UPDATE', handleNicknameUpdate);
    return () => {
      gateway.off('CONVERSATION_UPDATE', handleConversationUpdate);
      gateway.off('MEMBER_NICKNAME_UPDATE', handleNicknameUpdate);
    };
  }, [membershipIdentifier, refreshMembers, userId]);

  const resetMembers = useCallback(() => {
    setRefreshedMembers({ identifier: null, members: {} });
  }, []);
  return { members, refreshMembers, resetMembers };
}
