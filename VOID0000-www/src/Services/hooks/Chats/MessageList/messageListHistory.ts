import type { Conversation, ConversationMember } from '../../../Chat/chatService';

interface HistoryAccessFence {
  joinedAtMs: number;
}

const createHistoryAccessFence = (
  conversation: Conversation,
  currentMember?: ConversationMember | null,
): HistoryAccessFence | null => {
  if (conversation.type === 'dm' || !currentMember?.joined_at) return null;
  const joinedAtMs = new Date(currentMember.joined_at).getTime();
  return Number.isFinite(joinedAtMs) ? { joinedAtMs } : null;
};

const isMessageVisibleForHistoryFence = (
  message: { created_at: string },
  historyAccessFence: HistoryAccessFence | null,
) => {
  if (!historyAccessFence) return true;
  const createdAt = new Date(message.created_at).getTime();
  return !Number.isFinite(createdAt) || createdAt >= historyAccessFence.joinedAtMs;
};

const filterMessagesByHistoryFence = <T extends { created_at: string }>(
  messages: T[],
  historyAccessFence: HistoryAccessFence | null,
) => historyAccessFence
  ? messages.filter((message) => isMessageVisibleForHistoryFence(message, historyAccessFence))
  : messages;

export {
  createHistoryAccessFence,
  filterMessagesByHistoryFence,
  isMessageVisibleForHistoryFence,
};
export type { HistoryAccessFence };
