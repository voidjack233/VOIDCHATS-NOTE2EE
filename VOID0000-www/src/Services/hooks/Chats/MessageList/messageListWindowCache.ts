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

interface ConversationScrollGeometry {
  clientWidth: number;
  clientHeight: number;
  rectWidth: number;
  rectHeight: number;
}

const conversationWindowCache = new Map<string, ConversationWindowSnapshot>();

export const hasStableConversationScrollGeometry = ({
  clientWidth,
  clientHeight,
  rectWidth,
  rectHeight,
}: ConversationScrollGeometry) => (
  clientWidth > 1 &&
  clientHeight > 1 &&
  rectWidth > 1 &&
  rectHeight > 1
);

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

export type {
  ConversationScrollGeometry,
  ConversationScrollPosition,
  ConversationWindowSnapshot,
};
