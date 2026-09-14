import { useCallback, useEffect, useState } from 'react';
import type { Conversation, ConversationMember } from '../../Chat/chatTypes';
import { getConversationDetails, patchConversationProfiles } from '../../Chat/conversationCache';
import { gateway } from '../../Gateway/gateway';
import { useFriends } from '../Friends/useFriends';
import { patchProfileFields, type ProfileUpdate } from '../../Chat/profileIdentity';

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
  const { friends } = useFriends();
  const [refreshedMembers, setRefreshedMembers] = useState<ConversationMembersState>({
    identifier: null,
    members: {},
  });
  const membershipIdentifier = getMembershipIdentifier(activeConversation, activeGroup);
  const cachedDetails = getConversationDetails(membershipIdentifier);
  const cachedMembers = Object.fromEntries(
    (cachedDetails?.members || []).map((member) => [member.user_id, member]),
  );
  const baseMembers = refreshedMembers.identifier === membershipIdentifier
    ? refreshedMembers.members
    : cachedMembers;
  const members = Object.fromEntries(Object.entries(baseMembers).map(([id, member]) => {
    const friend = friends.find((entry) => entry.id === id);
    // Detail hydration may complete after an event initialized local member state.
    const profileId = cachedMembers[id]?.profile_id ?? member.profile_id;
    const identifiedMember = profileId === member.profile_id ? member : { ...member, profile_id: profileId };
    return [id, friend ? patchProfileFields(identifiedMember, { ...friend, user_id: id }) : identifiedMember];
  }));

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

    const handleProfileUpdate = (data: ProfileUpdate) => {
      patchConversationProfiles(data);
      setRefreshedMembers((current) => {
        // Normal group members initially live only in the detail cache. An event
        // must initialize React state too, without relying on a friends rerender.
        const currentMembers = current.identifier === membershipIdentifier
          ? current.members
          : Object.fromEntries(
              (getConversationDetails(membershipIdentifier)?.members || [])
                .map((member) => [member.user_id, member]),
            );
        const member = currentMembers[data.user_id];
        if (!member) return current;
        return { identifier: membershipIdentifier, members: {
          ...currentMembers,
          [data.user_id]: patchProfileFields(member, data),
        } };
      });
    };
    gateway.on('PROFILE_UPDATE', handleProfileUpdate);
    gateway.on('MEMBER_NICKNAME_UPDATE', handleNicknameUpdate);
    return () => {
      gateway.off('MEMBER_NICKNAME_UPDATE', handleNicknameUpdate);
      gateway.off('PROFILE_UPDATE', handleProfileUpdate);
    };
  }, [membershipIdentifier, userId]);

  const resetMembers = useCallback(() => {
    setRefreshedMembers({ identifier: null, members: {} });
  }, []);
  return { members, resetMembers };
}
