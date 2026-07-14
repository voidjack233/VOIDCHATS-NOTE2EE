import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../Auth/authServiceApi';
import type { Conversation, ConversationDetails, ConversationMember } from '../../Chat/chatTypes';
import { getConversationDetails, storeConversationDetails } from '../../Chat/conversationCache';
import { gateway } from '../../Gateway/gateway';

interface UseConversationMembersProps {
  activeConversation: Conversation | null;
  activeGroup: Conversation | null;
  userId?: string;
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
  const [members, setMembers] = useState<Record<string, ConversationMember>>({});
  const membershipIdentifier = getMembershipIdentifier(activeConversation, activeGroup);

  const refreshMembers = useCallback(async () => {
    if (!membershipIdentifier) {
      setMembers({});
      return;
    }

    const cached = getConversationDetails(membershipIdentifier);
    if (cached?.members) {
      setMembers(Object.fromEntries(cached.members.map((member) => [member.user_id, member])));
    }

    const response = await fetchWithAuth(`/api/conversations/${membershipIdentifier}`);
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Could not load conversation members');
    }
    const details = storeConversationDetails(data.conversation as ConversationDetails);
    const nextMembers = details.members || [];
    setMembers(Object.fromEntries(nextMembers.map((member) => [member.user_id, member])));
  }, [membershipIdentifier]);

  useEffect(() => {
    void refreshMembers().catch((error) => {
      console.warn('Failed to refresh conversation members:', error);
    });
  }, [refreshMembers]);

  useEffect(() => {
    if (!userId || !membershipIdentifier) return;

    const handleConversationUpdate = () => {
      void refreshMembers().catch(() => {});
    };
    const handleNicknameUpdate = (data: any) => {
      const targetUserId = String(data?.user_id || '');
      if (!targetUserId) return;
      const nickname = typeof data?.nickname === 'string' && data.nickname.trim()
        ? data.nickname.trim()
        : null;
      setMembers((current) => {
        const member = current[targetUserId];
        if (!member) return current;
        return { ...current, [targetUserId]: { ...member, nickname } };
      });
    };

    gateway.on('CONVERSATION_UPDATE', handleConversationUpdate);
    gateway.on('MEMBER_NICKNAME_UPDATE', handleNicknameUpdate);
    return () => {
      gateway.off('CONVERSATION_UPDATE', handleConversationUpdate);
      gateway.off('MEMBER_NICKNAME_UPDATE', handleNicknameUpdate);
    };
  }, [membershipIdentifier, refreshMembers, userId]);

  const resetMembers = useCallback(() => setMembers({}), []);
  return { members, refreshMembers, resetMembers };
}
