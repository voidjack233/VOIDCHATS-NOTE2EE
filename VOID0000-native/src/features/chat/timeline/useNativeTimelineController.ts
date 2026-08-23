import type { FlashListProps, FlashListRef } from '@shopify/flash-list';
import type { RefObject } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';

import {
  isPhysicallyAtPresent,
  shouldShowJumpToPresent,
  type TimelineMetrics,
} from './timelineGeometry';
import type {
  JumpToMessageOptions,
  JumpToPresentOptions,
  TimelineMessage,
  TimelineState,
  TimelineVisibleRange,
} from './timelineTypes';

interface NativeTimelineControllerOptions {
  listRef: RefObject<FlashListRef<TimelineMessage> | null>;
  messages: readonly TimelineMessage[];
  currentUserId: string;
  initialDataReady: boolean;
  initialScrollToStart: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  loadOlder?: () => Promise<void>;
  loadNewer?: () => Promise<void>;
  loadLatest?: () => Promise<void>;
  shouldForceFollowOnAppend?: (message: TimelineMessage) => boolean;
  onLoadError?: (direction: 'older' | 'newer', error: unknown) => void;
  onVisibleRangeChange?: (range: TimelineVisibleRange) => void;
  onStateChange?: (state: TimelineState) => void;
}

type ViewabilityHandler = NonNullable<
  FlashListProps<TimelineMessage>['onViewableItemsChanged']
>;

const INITIAL_STATE: TimelineState = {
  initialPositionComplete: false,
  isAtBeginning: false,
  isAtPresent: true,
  showJumpToPresent: false,
  pendingJumpMessageId: null,
  highlightedMessageId: null,
};

export function useNativeTimelineController({
  listRef,
  messages,
  currentUserId,
  initialDataReady,
  initialScrollToStart,
  hasOlder,
  hasNewer,
  loadingOlder,
  loadingNewer,
  loadOlder,
  loadNewer,
  loadLatest,
  shouldForceFollowOnAppend,
  onLoadError,
  onVisibleRangeChange,
  onStateChange,
}: NativeTimelineControllerOptions) {
  const [state, setState] = useState<TimelineState>(() => ({
    ...INITIAL_STATE,
    isAtBeginning: initialScrollToStart && !hasOlder,
    isAtPresent: !hasNewer,
    showJumpToPresent: hasNewer,
  }));
  const stateRef = useRef(state);
  const aliveRef = useRef(true);
  const messagesRef = useRef(messages);
  const previousMessagesRef = useRef(messages);
  const currentUserIdRef = useRef(currentUserId);
  const initialDataReadyRef = useRef(initialDataReady);
  const hasOlderRef = useRef(hasOlder);
  const hasNewerRef = useRef(hasNewer);
  const loadingOlderRef = useRef(loadingOlder);
  const loadingNewerRef = useRef(loadingNewer);
  const loadOlderRef = useRef(loadOlder);
  const loadNewerRef = useRef(loadNewer);
  const loadLatestRef = useRef(loadLatest);
  const shouldForceFollowOnAppendRef = useRef(shouldForceFollowOnAppend);
  const onLoadErrorRef = useRef(onLoadError);
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
  const metricsRef = useRef<TimelineMetrics>({
    contentHeight: 0,
    offsetY: 0,
    viewportHeight: 0,
  });
  const initialListLoadedRef = useRef(false);
  const initialPositionCompleteRef = useRef(false);
  const olderPromiseRef = useRef<Promise<void> | null>(null);
  const newerPromiseRef = useRef<Promise<boolean> | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpGenerationRef = useRef(0);

  messagesRef.current = messages;
  currentUserIdRef.current = currentUserId;
  initialDataReadyRef.current = initialDataReady;
  hasOlderRef.current = hasOlder;
  hasNewerRef.current = hasNewer;
  loadingOlderRef.current = loadingOlder;
  loadingNewerRef.current = loadingNewer;
  loadOlderRef.current = loadOlder;
  loadNewerRef.current = loadNewer;
  loadLatestRef.current = loadLatest;
  shouldForceFollowOnAppendRef.current = shouldForceFollowOnAppend;
  onLoadErrorRef.current = onLoadError;
  onVisibleRangeChangeRef.current = onVisibleRangeChange;

  const patchState = useCallback((patch: Partial<TimelineState>) => {
    const next = { ...stateRef.current, ...patch };
    const changed = Object.keys(patch).some(
      (key) =>
        stateRef.current[key as keyof TimelineState] !==
        next[key as keyof TimelineState],
    );
    if (!changed) return;
    stateRef.current = next;
    setState(next);
  }, []);

  const updateMetricsFromList = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    metricsRef.current.offsetY = Math.max(
      0,
      list.getAbsoluteLastScrollOffset(),
    );
    metricsRef.current.contentHeight = Math.max(
      0,
      list.getChildContainerDimensions().height,
    );
  }, [listRef]);

  const syncPositionState = useCallback(() => {
    const isAtPresent =
      isPhysicallyAtPresent(metricsRef.current) && !hasNewerRef.current;
    patchState({
      isAtBeginning:
        !hasOlderRef.current && metricsRef.current.offsetY <= 12,
      isAtPresent,
      showJumpToPresent: shouldShowJumpToPresent(
        metricsRef.current,
        hasNewerRef.current,
      ),
    });
  }, [patchState]);

  const scheduleScrollToPresent = useCallback(
    (animated: boolean) => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        const list = listRef.current;
        if (!list) return;
        list.scrollToEnd({ animated });
      });
    },
    [listRef],
  );

  const clearHighlight = useCallback(() => {
    if (highlightTimerRef.current !== null) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    if (stateRef.current.highlightedMessageId) {
      patchState({ highlightedMessageId: null });
    }
  }, [patchState]);

  const startHighlight = useCallback(
    (messageId: string) => {
      clearHighlight();
      patchState({ highlightedMessageId: messageId });
      highlightTimerRef.current = setTimeout(() => {
        highlightTimerRef.current = null;
        patchState({ highlightedMessageId: null });
      }, 1800);
    },
    [clearHighlight, patchState],
  );

  const requestOlder = useCallback(async (): Promise<boolean> => {
    const loader = loadOlderRef.current;
    if (
      !loader ||
      !hasOlderRef.current ||
      loadingOlderRef.current ||
      loadingNewerRef.current ||
      olderPromiseRef.current ||
      newerPromiseRef.current ||
      !initialPositionCompleteRef.current
    ) {
      return false;
    }

    const promise = Promise.resolve().then(loader);
    olderPromiseRef.current = promise;
    try {
      await promise;
      return true;
    } catch (error) {
      if (aliveRef.current) onLoadErrorRef.current?.('older', error);
      return false;
    } finally {
      if (olderPromiseRef.current === promise) olderPromiseRef.current = null;
    }
  }, []);

  const requestNewer = useCallback(
    (loaderOverride?: () => Promise<void>): Promise<boolean> => {
      if (newerPromiseRef.current) return newerPromiseRef.current;
      const loader = loaderOverride ?? loadNewerRef.current;
      if (
        !loader ||
        !hasNewerRef.current ||
        loadingNewerRef.current ||
        loadingOlderRef.current ||
        olderPromiseRef.current
      ) {
        return Promise.resolve(false);
      }

      const promise = (async () => {
        try {
          await loader();
          return true;
        } catch (error) {
          if (aliveRef.current) onLoadErrorRef.current?.('newer', error);
          return false;
        } finally {
          newerPromiseRef.current = null;
        }
      })();
      newerPromiseRef.current = promise;
      return promise;
    },
    [],
  );

  const completeInitialPosition = useCallback(() => {
    if (
      initialPositionCompleteRef.current ||
      !initialDataReadyRef.current ||
      !initialListLoadedRef.current
    ) {
      return;
    }

    initialPositionCompleteRef.current = true;
    updateMetricsFromList();
    patchState({ initialPositionComplete: true });
    syncPositionState();
  }, [patchState, syncPositionState, updateMetricsFromList]);

  const onLoad = useCallback(() => {
    initialListLoadedRef.current = true;
    completeInitialPosition();
  }, [completeInitialPosition]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      metricsRef.current.viewportHeight = event.nativeEvent.layout.height;
      completeInitialPosition();
    },
    [completeInitialPosition],
  );

  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      metricsRef.current.contentHeight = height;
      syncPositionState();
      completeInitialPosition();
    },
    [completeInitialPosition, syncPositionState],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      metricsRef.current.offsetY = Math.max(0, event.nativeEvent.contentOffset.y);
      metricsRef.current.contentHeight = event.nativeEvent.contentSize.height;
      metricsRef.current.viewportHeight = event.nativeEvent.layoutMeasurement.height;
      syncPositionState();
    },
    [syncPositionState],
  );

  const onViewableItemsChanged = useCallback<ViewabilityHandler>(
    ({ viewableItems }) => {
      const visible = viewableItems
        .filter(
          (token): token is typeof token & { index: number } =>
            token.isViewable && token.index !== null,
        )
        .sort((left, right) => left.index - right.index);
      const first = visible[0];
      const last = visible[visible.length - 1];
      onVisibleRangeChangeRef.current?.({
        firstMessageId: first?.item.id ?? null,
        lastMessageId: last?.item.id ?? null,
        firstIndex: first?.index ?? null,
        lastIndex: last?.index ?? null,
      });
    },
    [],
  );

  const jumpToMessage = useCallback(
    async (
      messageId: string,
      options: JumpToMessageOptions = {},
    ): Promise<boolean> => {
      const generation = ++jumpGenerationRef.current;
      clearHighlight();
      patchState({ pendingJumpMessageId: messageId });

      if (olderPromiseRef.current) {
        await olderPromiseRef.current.catch(() => undefined);
      }
      if (!aliveRef.current || generation !== jumpGenerationRef.current) {
        return false;
      }

      const index = messagesRef.current.findIndex(
        (message) => message.id === messageId,
      );
      if (index < 0 || !listRef.current) {
        patchState({ pendingJumpMessageId: null });
        return false;
      }

      try {
        await listRef.current.scrollToIndex({
          animated: options.animated ?? true,
          index,
          viewPosition: 0.5,
        });
      } catch {
        patchState({ pendingJumpMessageId: null });
        return false;
      }

      if (!aliveRef.current || generation !== jumpGenerationRef.current) {
        return false;
      }
      patchState({ pendingJumpMessageId: null });
      startHighlight(messageId);
      return true;
    },
    [clearHighlight, listRef, patchState, startHighlight],
  );

  const jumpToPresent = useCallback(
    async (options: JumpToPresentOptions = {}): Promise<void> => {
      const generation = ++jumpGenerationRef.current;
      clearHighlight();
      patchState({ pendingJumpMessageId: null });

      if (olderPromiseRef.current) {
        await olderPromiseRef.current.catch(() => undefined);
      }
      if (newerPromiseRef.current) {
        await newerPromiseRef.current;
      }
      if (!aliveRef.current || generation !== jumpGenerationRef.current) return;

      if (hasNewerRef.current) {
        const latestLoader = loadLatestRef.current;
        if (!latestLoader || !await requestNewer(latestLoader)) return;
      }
      if (!aliveRef.current || generation !== jumpGenerationRef.current) return;
      scheduleScrollToPresent(options.animated ?? true);
    },
    [clearHighlight, patchState, requestNewer, scheduleScrollToPresent],
  );

  const onStartReached = useCallback(() => {
    void requestOlder();
  }, [requestOlder]);

  const onEndReached = useCallback(() => {
    if (hasNewerRef.current) void requestNewer();
  }, [requestNewer]);

  useLayoutEffect(() => {
    const previous = previousMessagesRef.current;
    previousMessagesRef.current = messages;
    if (previous.length === 0 || messages.length === 0) return;

    const previousLastId = previous[previous.length - 1]?.id;
    const previousLastIndex = previousLastId
      ? messages.findIndex((message) => message.id === previousLastId)
      : -1;
    const appended = previousLastIndex >= 0 && previousLastIndex < messages.length - 1
      ? messages.slice(previousLastIndex + 1)
      : [];
    if (!appended.length) return;

    const forceFollowPredicate = shouldForceFollowOnAppendRef.current;
    const includesOwnOutput = appended.some((message) =>
      forceFollowPredicate
        ? forceFollowPredicate(message)
        : message.senderId === currentUserIdRef.current,
    );
    if (includesOwnOutput) scheduleScrollToPresent(true);
  }, [messages, scheduleScrollToPresent]);

  useEffect(() => {
    syncPositionState();
  }, [hasNewer, hasOlder, syncPositionState]);

  useEffect(() => {
    completeInitialPosition();
  }, [completeInitialPosition, initialDataReady]);

  useEffect(() => {
    onStateChange?.(state);
  }, [onStateChange, state]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      jumpGenerationRef.current += 1;
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      if (highlightTimerRef.current !== null) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
    };
  }, []);

  return {
    jumpToMessage,
    jumpToPresent,
    onContentSizeChange,
    onEndReached,
    onLayout,
    onLoad,
    onScroll,
    onScrollBeginDrag: clearHighlight,
    onStartReached,
    onViewableItemsChanged,
    requestOlder,
    state,
    stateRef,
  };
}
