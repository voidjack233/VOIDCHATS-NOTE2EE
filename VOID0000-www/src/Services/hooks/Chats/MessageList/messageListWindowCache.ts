interface ConversationWindowSnapshot {
  loadedCount: number;
  hasOlder: boolean;
  topVisibleMessageId?: string;
  topVisibleMessageOffset?: number;
  scrollTop?: number;
  wasAtBottom?: boolean;
}

interface ConversationScrollPosition {
  messageId?: string;
  offsetTop?: number;
  scrollTop: number;
  wasAtBottom: boolean;
}

const conversationWindowCache = new Map<string, ConversationWindowSnapshot>();

export const getConversationWindowSnapshot = (conversationId: string) =>
  conversationWindowCache.get(conversationId);

export const setConversationWindowSnapshot = (
  conversationId: string,
  snapshot: ConversationWindowSnapshot,
) => {
  conversationWindowCache.set(conversationId, snapshot);
};

export const saveConversationScrollPosition = (
  conversationId: string,
  position: ConversationScrollPosition,
) => {
  const existing = getConversationWindowSnapshot(conversationId);
  setConversationWindowSnapshot(conversationId, {
    loadedCount: existing?.loadedCount ?? 0,
    hasOlder: existing?.hasOlder ?? false,
    topVisibleMessageId: position.messageId,
    topVisibleMessageOffset: position.offsetTop,
    scrollTop: position.scrollTop,
    wasAtBottom: position.wasAtBottom,
  });
};

export const resolveInitialHasOlder = ({
  localHasMore,
  sessionSnapshot,
  syncHasMore = false,
}: {
  localHasMore: boolean;
  localCount: number;
  requestedLimit: number;
  sessionSnapshot?: ConversationWindowSnapshot;
  syncHasMore?: boolean;
}) => {
  return (
    localHasMore ||
    syncHasMore ||
    sessionSnapshot?.hasOlder === true
  );
};

export type { ConversationScrollPosition, ConversationWindowSnapshot };
