import { useEffect, useRef } from 'react';
import type { Conversation } from '../../Chat/chatService';
import { deleteConversationDetails } from '../../Chat/conversationCache';
import { messageStore } from '../../Chat/chatStore';
import { messageSync } from '../../Chat/chatSync';
import { matchesConversationIdentifier } from '../../Chat/utils/conversationUtils';
import { gateway } from '../../Gateway/gateway';

interface UseConversationSyncParams {
  activeConversation: Conversation | null;
  activeGroup: Conversation | null;
  user: { id: string } | null | undefined;
  onPatchConversation: (conversation: Conversation) => void;
  onBackToMe: () => void;
}

export const useConversationSync = ({
  activeConversation,
  activeGroup,
  user,
  onPatchConversation,
  onBackToMe,
}: UseConversationSyncParams) => {
  const onPatchConversationRef = useRef(onPatchConversation);
  const onBackToMeRef = useRef(onBackToMe);
  useEffect(() => { onPatchConversationRef.current = onPatchConversation; });
  useEffect(() => { onBackToMeRef.current = onBackToMe; });

  useEffect(() => {
    if (!user?.id) return;
    const handleConversationUpdate = (data: any) => {
      if (data?.conversation) onPatchConversationRef.current(data.conversation as Conversation);
    };
    gateway.on('CONVERSATION_UPDATE', handleConversationUpdate);
    return () => gateway.off('CONVERSATION_UPDATE', handleConversationUpdate);
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    const handleMemberLeave = (data: any) => {
      const conversationId = data?.conversation_id;
      if (!conversationId) return;
      const affectedUserId = data?.user_id || data?.member_user_id || data?.target_user_id || data?.removed_user_id;
      if (affectedUserId && String(affectedUserId) !== String(user.id)) return;

      [conversationId, data?.conversation_public_id]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .forEach(deleteConversationDetails);
      void messageStore.clearConversation(conversationId).catch(() => {});
      messageSync.invalidateConversation(conversationId);

      if (
        matchesConversationIdentifier(activeConversation, conversationId) ||
        matchesConversationIdentifier(activeGroup, conversationId)
      ) {
        onBackToMeRef.current();
      }
    };
    gateway.on('MEMBER_LEAVE', handleMemberLeave);
    return () => gateway.off('MEMBER_LEAVE', handleMemberLeave);
  }, [activeConversation, activeGroup, user?.id]);
};
