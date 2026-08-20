import { useEffect } from 'react';
import type { Conversation, Message } from '../../../Services/Chat/chatService';
import { setConversationPreviewFromMessage } from '../../../Services/Chat/conversationPreviewCache';

export function useConversationPreviewCache({
  conversation,
  messages,
  currentUserId,
  hasNewer,
  bottomSpacerHeight,
}: {
  conversation: Conversation;
  messages: Message[];
  currentUserId?: string;
  hasNewer: boolean;
  bottomSpacerHeight: number;
}) {
  useEffect(() => {
    // A trimmed history window is not authoritative for the conversation's
    // latest-message preview. Live events and the local store own that state
    // until this view reaches the present again.
    if (hasNewer || bottomSpacerHeight > 1) {
      return;
    }

    const latestMessage = [...messages].reverse().find((message) =>
      String(message.conversation_id || conversation.id) === String(conversation.id)
    ) || null;
    if (!latestMessage) {
      return;
    }

    setConversationPreviewFromMessage(
      [conversation.id, conversation.public_id],
      latestMessage,
      currentUserId,
    );
  }, [
    bottomSpacerHeight,
    conversation,
    currentUserId,
    hasNewer,
    messages,
  ]);
}
