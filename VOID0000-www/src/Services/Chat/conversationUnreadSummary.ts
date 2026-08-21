import type { Conversation } from './chatTypes';

export interface ConversationUnreadTotals {
  dm: number;
  group: number;
}

const MAX_UNREAD_TOTAL = Number.MAX_SAFE_INTEGER;

function normalizeUnreadCount(value: number | null | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return 0;
  return Math.min(Math.trunc(value), MAX_UNREAD_TOTAL);
}

export function getConversationUnreadTotals(
  conversations: Conversation[],
): ConversationUnreadTotals {
  return conversations.reduce<ConversationUnreadTotals>((totals, conversation) => {
    if (conversation.type !== 'dm' && conversation.type !== 'group') return totals;

    const unreadCount = normalizeUnreadCount(conversation.unread_count);
    totals[conversation.type] = Math.min(
      totals[conversation.type] + unreadCount,
      MAX_UNREAD_TOTAL,
    );
    return totals;
  }, { dm: 0, group: 0 });
}

export function formatUnreadBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(Math.max(0, Math.trunc(count)));
}
