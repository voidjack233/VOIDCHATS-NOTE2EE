import type { Conversation } from './chatTypes';

interface ApplyConversationMessageCreateInput {
  conversations: Conversation[];
  conversationId: string;
  messageId: string | null;
  senderId: string | null;
  createdAt: string;
  preview: string | null;
  currentUserId: string | null;
  activeConversationId: string | null;
}

export function applyConversationMessageCreate({
  conversations,
  conversationId,
  messageId,
  senderId,
  createdAt,
  preview,
  currentUserId,
  activeConversationId,
}: ApplyConversationMessageCreateInput): Conversation[] {
  const index = conversations.findIndex((conversation) => conversation.id === conversationId);
  if (index === -1) return conversations;

  const next = [...conversations];
  const conversation = next.splice(index, 1)[0] as Conversation;
  const isSender = Boolean(currentUserId && senderId === currentUserId);
  const isActiveConversation = activeConversationId === conversationId;
  const unreadCount = isSender || isActiveConversation
    ? 0
    : Math.max(0, (conversation.unread_count ?? 0) + 1);

  next.unshift({
    ...conversation,
    updated_at: createdAt,
    unread_count: unreadCount,
    last_message_id: messageId || conversation.last_message_id || null,
    last_message_sender_id: senderId || conversation.last_message_sender_id || null,
    last_message_preview: preview,
    last_read_message_id: isSender
      ? messageId || conversation.last_read_message_id
      : conversation.last_read_message_id,
  });

  return next;
}
