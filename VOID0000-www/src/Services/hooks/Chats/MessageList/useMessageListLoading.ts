import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { MESSAGE_INITIAL_PAGE_SIZE } from '../../../Chat/chatConstants';
import { messageSync } from '../../../Chat/chatSync';
import type { Message } from '../../../Chat/chatService';
import { messageStore } from '../../../Chat/chatStore';
import { type HistoryAccessFence, filterMessagesByHistoryFence } from './messageListHistory';
import { sortMessages, toUIMessage } from './messageListPersistence';
import {
  getConversationWindowSnapshot,
  resolveInitialHasOlder,
} from './messageListWindowCache';
import {
  getRenderedMessages,
  getSavedConversationRuntime,
  type ConversationRuntime,
} from './messageListRuntime';
import { markStartupPerformanceOnce } from '../../../Performance/startupPerformance';
import {
  canSettleInitialHydrationFromCachedWindow,
  createCachedHistoricalWindow,
  hasCachedMessagesAfterWindow,
} from './messageListInitialRuntime';

interface UseMessageListLoadingParams {
  conversationId: string;
  historyAccessFence: HistoryAccessFence | null;
  historyAccessFenceSignature: string;
  userId?: string;
  onMessagesLoaded?: (messages: Message[]) => void;
  messageListBaseIndex: number;
  replaceWindow: (params: {
    messages: Message[];
    firstItemIndex?: number;
    groupBreakBeforeIds?: Set<string>;
    loading?: boolean;
    syncing?: boolean;
    initialHydrationSettled?: boolean;
    loadingOlder?: boolean;
    loadingNewer?: boolean;
    hasOlder?: boolean;
    hasNewer?: boolean;
    isAtPresent?: boolean;
  }) => void;
  restoreRuntime: (params: {
    runtime: ConversationRuntime;
    firstItemIndex?: number;
    groupBreakBeforeIds?: Set<string>;
    loading?: boolean;
    syncing?: boolean;
    initialHydrationSettled?: boolean;
    loadingOlder?: boolean;
    loadingNewer?: boolean;
    hasOlder?: boolean;
    hasNewer?: boolean;
    isAtPresent?: boolean;
  }) => void;
  mergeVisibleMessages: (params: {
    incoming: Message[];
    currentUserId?: string;
    trimFrom?: 'old' | 'new';
    hasOlder?: boolean;
    hasNewer?: boolean;
    isAtPresent?: boolean;
  }) => void;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setSyncing: Dispatch<SetStateAction<boolean>>;
  setHasOlder: Dispatch<SetStateAction<boolean>>;
  setHasNewer: Dispatch<SetStateAction<boolean>>;
  setInitialHydrationSettled: Dispatch<SetStateAction<boolean>>;
  messagesRef: MutableRefObject<Message[]>;
  lastLoadedConversationIdRef: MutableRefObject<string | null>;
}

const INITIAL_OPEN_LIMIT = MESSAGE_INITIAL_PAGE_SIZE;

const useMessageListLoading = ({
  conversationId,
  historyAccessFence,
  historyAccessFenceSignature,
  userId,
  onMessagesLoaded,
  messageListBaseIndex,
  replaceWindow,
  restoreRuntime,
  mergeVisibleMessages,
  setLoading,
  setSyncing,
  setHasOlder,
  setHasNewer,
  setInitialHydrationSettled,
  messagesRef,
  lastLoadedConversationIdRef,
}: UseMessageListLoadingParams) => {
  const lastLoadedHistoryFenceSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    let ignore = false;
    const sessionSnapshot = getConversationWindowSnapshot(conversationId);

    const settleInitialHydration = () => {
      if (!ignore) setInitialHydrationSettled(true);
    };

    const resetVisibleWindow = () => {
      replaceWindow({
        messages: [],
        firstItemIndex: messageListBaseIndex,
        groupBreakBeforeIds: new Set(),
        loading: true,
        syncing: false,
        loadingOlder: false,
        loadingNewer: false,
        hasOlder: false,
        hasNewer: false,
        isAtPresent: true,
      });
    };

    const restoreSavedRuntime = (): ConversationRuntime | null => {
      const savedRuntime = getSavedConversationRuntime(conversationId);
      if (!savedRuntime) return null;

      const savedMessages = getRenderedMessages(savedRuntime);
      if (savedMessages.length === 0) return null;

      restoreRuntime({
        runtime: savedRuntime,
        firstItemIndex: messageListBaseIndex,
        groupBreakBeforeIds: new Set(),
        loading: false,
        syncing: false,
        initialHydrationSettled: true,
        loadingOlder: false,
        loadingNewer: false,
        hasOlder: savedRuntime.hasOlder,
        hasNewer: savedRuntime.hasNewer,
        isAtPresent: !savedRuntime.hasNewer,
      });
      onMessagesLoaded?.(savedMessages);
      markStartupPerformanceOnce('cached-messages-ready');
      settleInitialHydration();
      return savedRuntime;
    };

    const readCachedHistoricalWindow = async () => {
      const anchorId = sessionSnapshot?.wasAtBottom === false
        ? sessionSnapshot.topVisibleMessageId
        : null;
      if (!anchorId) return null;

      const anchor = await messageStore.getMessage(conversationId, anchorId);
      if (!anchor) return null;

      const olderLimit = Math.max(1, Math.floor((INITIAL_OPEN_LIMIT - 1) / 3));
      const newerLimit = Math.max(1, INITIAL_OPEN_LIMIT - olderLimit - 1);
      const [before, after] = await Promise.all([
        messageSync.readLocal(conversationId, { before: anchorId, limit: olderLimit }),
        messageSync.readLocal(conversationId, { after: anchorId, limit: newerLimit }),
      ]);
      const cachedWindow = createCachedHistoricalWindow({ anchor, before, after });
      if (!cachedWindow) return null;

      const visibleMessages = filterMessagesByHistoryFence(cachedWindow.messages, historyAccessFence);
      if (!visibleMessages.some((message) => message.message_id === anchorId)) {
        return null;
      }

      return {
        messages: sortMessages(visibleMessages.map(toUIMessage)),
        hasOlder: cachedWindow.hasOlder,
        hasNewer: cachedWindow.hasNewer,
      };
    };

    const applyVisibleMessages = (
      nextMessages: Message[],
      shouldPreserveMessages: boolean,
      options: {
        hasOlder?: boolean;
        hasNewer?: boolean;
        isAtPresent?: boolean;
        loading?: boolean;
        syncing?: boolean;
      },
    ) => {
      if (shouldPreserveMessages) {
        if (nextMessages.length === 0) return;
        mergeVisibleMessages({
          incoming: nextMessages,
          currentUserId: userId,
          trimFrom: 'old',
          hasOlder: options.hasOlder,
          hasNewer: options.hasNewer,
          isAtPresent: options.isAtPresent,
        });
        return;
      }

      replaceWindow({
        messages: nextMessages,
        firstItemIndex: messageListBaseIndex,
        groupBreakBeforeIds: new Set(),
        ...options,
      });
    };

    const load = async () => {
      markStartupPerformanceOnce('message-hydration-start');
      const shouldPreserveMessages =
        lastLoadedConversationIdRef.current === conversationId &&
        lastLoadedHistoryFenceSignatureRef.current === historyAccessFenceSignature;
      lastLoadedConversationIdRef.current = conversationId;
      lastLoadedHistoryFenceSignatureRef.current = historyAccessFenceSignature;

      const savedRuntime = !shouldPreserveMessages && historyAccessFenceSignature === 'none'
        ? restoreSavedRuntime()
        : null;

      // Keep an intentionally historical window exactly where the user left it.
      // A runtime that was at present still needs to consume messages persisted by
      // the global conversation-list listener while this conversation was inactive.
      if (savedRuntime?.hasNewer) {
        return;
      }

      const shouldPreserveVisibleMessages = shouldPreserveMessages || Boolean(savedRuntime);
      if (!shouldPreserveVisibleMessages) resetVisibleWindow();

      try {
        const [cachedHistoricalWindow, { cached, syncPromise }] = await Promise.all([
          savedRuntime ? Promise.resolve(null) : readCachedHistoricalWindow(),
          messageSync.loadConversation(conversationId, {
            forceSync: false,
            preferSessionCache: true,
            initialLimit: INITIAL_OPEN_LIMIT,
            syncLimit: INITIAL_OPEN_LIMIT,
            initiator: 'message_list_open',
            savedRuntimeExists: Boolean(savedRuntime),
          }),
        ]);
        if (ignore) return;

        const cachedMessages = filterMessagesByHistoryFence(cached.messages, historyAccessFence);
        const cachedUI = sortMessages(cachedMessages.map(toUIMessage));
        if (cachedHistoricalWindow) {
          const hasCachedNewerMessages = hasCachedMessagesAfterWindow(
            cachedHistoricalWindow.messages,
            cachedUI,
          );
          applyVisibleMessages(cachedHistoricalWindow.messages, false, {
            hasOlder: cachedHistoricalWindow.hasOlder,
            hasNewer: cachedHistoricalWindow.hasNewer || hasCachedNewerMessages,
            isAtPresent: false,
            loading: false,
          });
          onMessagesLoaded?.(cachedHistoricalWindow.messages);
          markStartupPerformanceOnce('cached-messages-ready');
          settleInitialHydration();
        } else if (cachedUI.length > 0) {
          applyVisibleMessages(cachedUI, shouldPreserveVisibleMessages, {
            hasOlder: resolveInitialHasOlder({
              localHasMore: cached.has_more,
              localCount: cachedUI.length,
              requestedLimit: INITIAL_OPEN_LIMIT,
              sessionSnapshot,
            }),
            hasNewer: false,
            isAtPresent: true,
            loading: false,
          });
          onMessagesLoaded?.(cachedUI);
          markStartupPerformanceOnce('cached-messages-ready');
          if (canSettleInitialHydrationFromCachedWindow(cachedUI)) {
            settleInitialHydration();
          }
        }

        setSyncing(true);
        const syncResult = await syncPromise;
        if (ignore) return;
        setSyncing(false);
        if (cachedHistoricalWindow) {
          if (syncResult.newMessages.length > 0) {
            setHasNewer(true);
          }
          return;
        }
        setHasOlder((previous) => previous || syncResult.hasMore);

        if (cachedUI.length > 0 && !syncResult.didSync) {
          settleInitialHydration();
          return;
        }

        const fresh = await messageSync.readLocal(conversationId, { limit: INITIAL_OPEN_LIMIT });
        if (ignore) return;

        const freshMessages = filterMessagesByHistoryFence(fresh.messages, historyAccessFence);
        const freshUI = sortMessages(freshMessages.map(toUIMessage));
        applyVisibleMessages(freshUI, Boolean(savedRuntime), {
          hasOlder: resolveInitialHasOlder({
            localHasMore: fresh.has_more,
            localCount: freshUI.length,
            requestedLimit: INITIAL_OPEN_LIMIT,
            sessionSnapshot,
            syncHasMore: syncResult.hasMore,
          }),
          hasNewer: false,
          isAtPresent: true,
          loading: false,
          syncing: false,
        });
        onMessagesLoaded?.(freshUI);
        if (freshUI.length > 0) {
          markStartupPerformanceOnce('messages-ready');
        }
        settleInitialHydration();
      } catch (error) {
        if (ignore) return;
        console.error('Failed to load messages:', error);
        setLoading(false);
        setSyncing(false);
        settleInitialHydration();
      }
    };

    void load();
    return () => {
      ignore = true;
    };
  }, [
    conversationId,
    historyAccessFence,
    historyAccessFenceSignature,
    lastLoadedConversationIdRef,
    mergeVisibleMessages,
    messageListBaseIndex,
    messagesRef,
    onMessagesLoaded,
    replaceWindow,
    restoreRuntime,
    setHasOlder,
    setHasNewer,
    setInitialHydrationSettled,
    setLoading,
    setSyncing,
    userId,
  ]);
};

export { useMessageListLoading };
