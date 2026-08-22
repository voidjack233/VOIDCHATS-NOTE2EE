import type { FlashListProps, FlashListRef } from '@shopify/flash-list';
import type { RefObject } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  Keyboard,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import {
  HISTORY_LOAD_COOLDOWN_MS,
  RESTORE_TOLERANCE_PX,
  estimatedMessageOffset,
  isNearHistoryStart,
  isPhysicallyAtPresent,
  isViewportUnderfilled,
  shouldShowJumpToPresent,
  type TimelineMetrics,
} from './timelineGeometry';
import type {
  JumpToMessageOptions,
  JumpToPresentOptions,
  TimelineHistoryPhase,
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

interface VisibleAnchor {
  messageId: string;
  index: number;
  screenOffset: number;
}

interface HistoryTransaction {
  anchor: VisibleAnchor | null;
  beforeFirstId: string | null;
  beforeLength: number;
  fallbackUsed: boolean;
  phase: Exclude<TimelineHistoryPhase, 'idle'>;
  pinToPresent: boolean;
}

interface NewerTransaction {
  token: number;
}

interface LatestCommitWaiter {
  resolve: (committed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

type FollowReason = 'append-present' | 'own-message' | 'jump-present';

interface FollowIntent {
  animated: boolean;
  ready: boolean;
  reason: FollowReason;
}

interface GeometryCorrection {
  anchor: VisibleAnchor | null;
  highlightedMessageId: string | null;
  pinToPresent: boolean;
}

type ViewabilityHandler = NonNullable<
  FlashListProps<TimelineMessage>['onViewableItemsChanged']
>;

const INITIAL_STATE: TimelineState = {
  initialRestoreComplete: false,
  isAtBeginning: false,
  isAtPresent: true,
  showJumpToPresent: false,
  isLoadingHistory: false,
  historyPhase: 'idle',
  pendingJumpMessageId: null,
  highlightedMessageId: null,
};

function waitForLayout(delayMs = 32): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

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
  const initialScrollToStartRef = useRef(initialScrollToStart);
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
  const visibleAnchorRef = useRef<VisibleAnchor | null>(null);
  const historyTransactionRef = useRef<HistoryTransaction | null>(null);
  const historyLoadPromiseRef = useRef<Promise<void> | null>(null);
  const historyCooldownUntilRef = useRef(0);
  const underfilledBoundaryRef = useRef<string | null>(null);
  const userInteractingRef = useRef(false);
  const initialListLoadedRef = useRef(false);
  const initialRestoreCompleteRef = useRef(false);
  const initialRestoreInFlightRef = useRef(false);
  const followIntentRef = useRef<FollowIntent | null>(null);
  const forceFollowOutputRef = useRef(false);
  const forceFollowRetryUsedRef = useRef(false);
  const followMovementInFlightRef = useRef(false);
  const activeFollowReasonRef = useRef<FollowReason | null>(null);
  const followFrameRef = useRef<number | null>(null);
  const scheduleFollowRef = useRef<
    (reason: FollowReason, animated: boolean, ready?: boolean) => void
  >(() => undefined);
  const followSettleGenerationRef = useRef(0);
  const historyRestoreFrameRef = useRef<number | null>(null);
  const geometryCorrectionRef = useRef<GeometryCorrection | null>(null);
  const geometryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyNoDataTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const proactiveLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const newerRequestRef = useRef(false);
  const newerTransactionTokenRef = useRef(0);
  const newerPromiseRef = useRef<Promise<boolean> | null>(null);
  const newerTransactionRef = useRef<NewerTransaction | null>(null);
  const newerNoDataTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCommitWaitersRef = useRef(new Set<LatestCommitWaiter>());
  const jumpGenerationRef = useRef(0);
  const jumpScrollPromiseRef = useRef<Promise<boolean> | null>(null);
  const viewportAnchorRef = useRef<VisibleAnchor | null>(null);
  const viewportResizeHandledRef = useRef(false);
  const requestOlderRef = useRef<() => Promise<boolean>>(async () => false);

  messagesRef.current = messages;
  currentUserIdRef.current = currentUserId;
  initialDataReadyRef.current = initialDataReady;
  initialScrollToStartRef.current = initialScrollToStart;
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

    if (!changed) {
      return;
    }

    stateRef.current = next;
    setState(next);
  }, []);

  const resolveLatestCommitWaiters = useCallback((committed: boolean) => {
    latestCommitWaitersRef.current.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.resolve(committed);
    });
    latestCommitWaitersRef.current.clear();
  }, []);

  const waitForLatestCommit = useCallback(
    (timeoutMs = 5000): Promise<boolean> => {
      if (!hasNewerRef.current) {
        return Promise.resolve(true);
      }

      return new Promise((resolve) => {
        const waiter: LatestCommitWaiter = {
          resolve,
          timer: setTimeout(() => {
            latestCommitWaitersRef.current.delete(waiter);
            resolve(false);
          }, timeoutMs),
        };
        latestCommitWaitersRef.current.add(waiter);
      });
    },
    [],
  );

  const setHistoryPhase = useCallback(
    (phase: TimelineHistoryPhase) => {
      if (historyTransactionRef.current && phase !== 'idle') {
        historyTransactionRef.current.phase = phase;
      }
      patchState({
        historyPhase: phase,
        isLoadingHistory: phase !== 'idle' || loadingOlderRef.current,
      });
    },
    [patchState],
  );

  const captureVisibleAnchor = useCallback((): VisibleAnchor | null => {
    const list = listRef.current;
    const items = messagesRef.current;

    if (!list || items.length === 0) {
      return null;
    }

    const priorAnchor = visibleAnchorRef.current;
    const currentPriorIndex = priorAnchor
      ? items.findIndex((message) => message.id === priorAnchor.messageId)
      : -1;
    const reportedVisibleIndex = list.getFirstVisibleIndex();
    const visibleIndex = reportedVisibleIndex >= 0
      ? reportedVisibleIndex
      : currentPriorIndex;
    const index = Math.max(0, Math.min(visibleIndex, items.length - 1));
    const message = items[index];
    const layout = list.getLayout(index);

    if (!message) {
      return null;
    }

    if (!layout) {
      const prior = visibleAnchorRef.current;
      return prior?.messageId === message.id
        ? prior
        : { messageId: message.id, index, screenOffset: 0 };
    }

    const offsetY = Math.max(0, list.getAbsoluteLastScrollOffset());
    metricsRef.current.offsetY = offsetY;
    return {
      messageId: message.id,
      index,
      screenOffset: layout.y - offsetY,
    };
  }, [listRef]);

  const syncPositionState = useCallback(() => {
    const physicallyAtPresent = isPhysicallyAtPresent(metricsRef.current);
    if (physicallyAtPresent) {
      forceFollowOutputRef.current = false;
      forceFollowRetryUsedRef.current = false;
    }
    patchState({
      isAtBeginning:
        !hasOlderRef.current && metricsRef.current.offsetY <= 12,
      isAtPresent: physicallyAtPresent && !hasNewerRef.current,
      showJumpToPresent: shouldShowJumpToPresent(
        metricsRef.current,
        hasNewerRef.current,
      ),
    });
  }, [patchState]);

  const updateMetricsFromList = useCallback(() => {
    const list = listRef.current;
    if (!list) return false;
    metricsRef.current.offsetY = Math.max(
      0,
      list.getAbsoluteLastScrollOffset(),
    );
    metricsRef.current.contentHeight = Math.max(
      0,
      list.getChildContainerDimensions().height,
    );
    return isPhysicallyAtPresent(metricsRef.current);
  }, [listRef]);

  const waitForListAtPresent = useCallback(async (
    timeoutMs: number,
    shouldContinue: () => boolean,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    let consecutiveMeasurements = 0;
    while (aliveRef.current && shouldContinue() && Date.now() < deadline) {
      consecutiveMeasurements = updateMetricsFromList()
        ? consecutiveMeasurements + 1
        : 0;
      if (consecutiveMeasurements >= 2) return true;
      await waitForLayout();
    }
    return shouldContinue() && updateMetricsFromList();
  }, [updateMetricsFromList]);

  const scrollToPresentSettled = useCallback(async (
    animated: boolean,
    shouldContinue: () => boolean = () => true,
  ): Promise<boolean> => {
    const list = listRef.current;
    if (!list || !shouldContinue()) return false;
    try {
      await list.scrollToEnd({ animated });
    } catch {
      // Retry once without animation after the list has completed layout.
    }
    if (await waitForListAtPresent(animated ? 1_500 : 600, shouldContinue)) {
      return true;
    }
    if (!shouldContinue()) return false;
    try {
      await list.scrollToEnd({ animated: false });
    } catch {
      return false;
    }
    return waitForListAtPresent(600, shouldContinue);
  }, [listRef, waitForListAtPresent]);

  const fulfillFollowIntent = useCallback(() => {
    const intent = followIntentRef.current;

    if (!intent?.ready) {
      return;
    }

    followIntentRef.current = null;
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = null;
    }
    followMovementInFlightRef.current = true;
    activeFollowReasonRef.current = intent.reason;
    const generation = ++followSettleGenerationRef.current;
    const settleFollow = async () => {
      await scrollToPresentSettled(
        intent.animated,
        () => generation === followSettleGenerationRef.current,
      );
      if (!aliveRef.current || generation !== followSettleGenerationRef.current) {
        return;
      }
      syncPositionState();
      followMovementInFlightRef.current = false;
      activeFollowReasonRef.current = null;
      if (
        forceFollowOutputRef.current &&
        !forceFollowRetryUsedRef.current
      ) {
        forceFollowRetryUsedRef.current = true;
        scheduleFollowRef.current('own-message', false, true);
      } else if (forceFollowOutputRef.current) {
        forceFollowOutputRef.current = false;
        forceFollowRetryUsedRef.current = false;
      }
      const queuedIntent = followIntentRef.current;
      if (queuedIntent?.ready && followFrameRef.current === null) {
        scheduleFollowRef.current(
          queuedIntent.reason,
          queuedIntent.animated,
          true,
        );
      }
    };
    void settleFollow();
  }, [scrollToPresentSettled, syncPositionState]);

  const scheduleFollow = useCallback(
    (reason: FollowReason, animated: boolean, ready = true) => {
      if (reason === 'own-message') {
        if (!forceFollowOutputRef.current) {
          forceFollowRetryUsedRef.current = false;
        }
        forceFollowOutputRef.current = true;
        if (geometryCorrectionRef.current) {
          geometryCorrectionRef.current.highlightedMessageId = null;
          geometryCorrectionRef.current.pinToPresent = true;
        }
      }
      if (reason === 'jump-present' && geometryCorrectionRef.current) {
        geometryCorrectionRef.current.highlightedMessageId = null;
        geometryCorrectionRef.current.pinToPresent = true;
      }
      const existing = followIntentRef.current;
      const mergedReason: FollowReason =
        reason === 'jump-present' || existing?.reason === 'jump-present'
          ? 'jump-present'
          : reason === 'own-message' || existing?.reason === 'own-message'
            ? 'own-message'
            : 'append-present';
      followIntentRef.current = {
        animated: existing?.animated || animated,
        ready: existing?.ready || ready,
        reason: mergedReason,
      };

      if (
        !followIntentRef.current.ready ||
        followFrameRef.current !== null ||
        followMovementInFlightRef.current
      ) {
        return;
      }

      followFrameRef.current = requestAnimationFrame(() => {
        followFrameRef.current = null;
        fulfillFollowIntent();
      });
    },
    [fulfillFollowIntent],
  );
  scheduleFollowRef.current = scheduleFollow;

  const cancelFollowMovement = useCallback(() => {
    followIntentRef.current = null;
    forceFollowOutputRef.current = false;
    forceFollowRetryUsedRef.current = false;
    followMovementInFlightRef.current = false;
    activeFollowReasonRef.current = null;
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = null;
    }
    followSettleGenerationRef.current += 1;
    if (geometryTimerRef.current !== null) {
      clearTimeout(geometryTimerRef.current);
      geometryTimerRef.current = null;
    }
    geometryCorrectionRef.current = null;
  }, []);

  const cancelAppendFollowMovement = useCallback(() => {
    const queuedIntent = followIntentRef.current;
    const cancelQueuedAppend = queuedIntent?.reason === 'append-present';
    const cancelActiveAppend = activeFollowReasonRef.current === 'append-present';

    if (cancelQueuedAppend) {
      followIntentRef.current = null;
      if (followFrameRef.current !== null) {
        cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = null;
      }
    }

    if (cancelActiveAppend) {
      followSettleGenerationRef.current += 1;
      followMovementInFlightRef.current = false;
      activeFollowReasonRef.current = null;
    }

    const priorityIntent = followIntentRef.current;
    const priorityMovementActive =
      activeFollowReasonRef.current === 'own-message' ||
      activeFollowReasonRef.current === 'jump-present';
    if (!priorityIntent && !priorityMovementActive) {
      if (geometryTimerRef.current !== null) {
        clearTimeout(geometryTimerRef.current);
        geometryTimerRef.current = null;
      }
      geometryCorrectionRef.current = null;
    }

    if (cancelActiveAppend && priorityIntent?.ready) {
      scheduleFollowRef.current(
        priorityIntent.reason,
        priorityIntent.animated,
        true,
      );
    }
  }, []);

  const restoreAnchorOnce = useCallback(
    (anchor: VisibleAnchor): boolean => {
      const list = listRef.current;
      const index = messagesRef.current.findIndex(
        (message) => message.id === anchor.messageId,
      );

      if (!list || index < 0) {
        return false;
      }

      const layout = list.getLayout(index);
      if (!layout) {
        return false;
      }

      const offsetY = Math.max(0, list.getAbsoluteLastScrollOffset());
      metricsRef.current.offsetY = offsetY;
      const currentScreenOffset = layout.y - offsetY;
      const correction = currentScreenOffset - anchor.screenOffset;
      if (Math.abs(correction) <= RESTORE_TOLERANCE_PX) {
        return true;
      }

      list.scrollToOffset({
        animated: false,
        offset: Math.max(0, offsetY + correction),
      });
      return true;
    },
    [listRef],
  );

  const isIndexVisible = useCallback(
    (index: number): boolean => {
      const list = listRef.current;
      if (!list) {
        return false;
      }

      const visible = list.computeVisibleIndices();
      if (index >= visible.startIndex && index <= visible.endIndex) {
        return true;
      }

      const layout = list.getLayout(index);
      if (!layout) {
        return false;
      }

      const offsetY = Math.max(0, list.getAbsoluteLastScrollOffset());
      metricsRef.current.offsetY = offsetY;
      const top = layout.y - offsetY;
      return top < metricsRef.current.viewportHeight && top + layout.height > 0;
    },
    [listRef],
  );

  const scrollToIndexBounded = useCallback(
    async (index: number, animated: boolean): Promise<boolean> => {
      const list = listRef.current;
      const itemCount = messagesRef.current.length;
      if (!list || index < 0 || index >= itemCount) {
        return false;
      }

      await list.scrollToIndex({ animated, index, viewPosition: 0.5 });
      await waitForLayout(animated ? 220 : 32);
      if (isIndexVisible(index)) {
        return true;
      }

      const layout = list.getLayout(index);
      list.scrollToOffset({
        animated: false,
        offset: layout
          ? Math.max(
              0,
              layout.y - metricsRef.current.viewportHeight / 2 + layout.height / 2,
            )
          : estimatedMessageOffset(
              index,
              itemCount,
              metricsRef.current.contentHeight,
              metricsRef.current.viewportHeight,
            ),
      });
      await waitForLayout();
      await list.scrollToIndex({ animated: false, index, viewPosition: 0.5 });
      await waitForLayout();
      return isIndexVisible(index);
    },
    [isIndexVisible, listRef],
  );

  const clearHighlightTimer = useCallback(() => {
    if (highlightTimerRef.current !== null) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
  }, []);

  const startHighlight = useCallback(
    (messageId: string) => {
      clearHighlightTimer();
      patchState({ highlightedMessageId: messageId });
      highlightTimerRef.current = setTimeout(() => {
        highlightTimerRef.current = null;
        patchState({ highlightedMessageId: null });
      }, 1800);
    },
    [clearHighlightTimer, patchState],
  );

  const finishHistoryTransaction = useCallback(
    (expected?: HistoryTransaction) => {
    if (!aliveRef.current) {
      return;
    }
    if (expected && historyTransactionRef.current !== expected) {
      return;
    }
    historyTransactionRef.current = null;
    historyCooldownUntilRef.current = Date.now() + HISTORY_LOAD_COOLDOWN_MS;
    setHistoryPhase('idle');

    proactiveLoadTimerRef.current = setTimeout(() => {
      proactiveLoadTimerRef.current = null;
      const boundary = `${messagesRef.current[0]?.id ?? 'empty'}:${messagesRef.current.length}`;
      if (
        initialRestoreCompleteRef.current &&
        hasOlderRef.current &&
        (isViewportUnderfilled(metricsRef.current) ||
          isNearHistoryStart(metricsRef.current)) &&
        underfilledBoundaryRef.current !== boundary
      ) {
        underfilledBoundaryRef.current = boundary;
        void requestOlderRef.current();
      }
    }, HISTORY_LOAD_COOLDOWN_MS + 16);
    },
    [setHistoryPhase],
  );

  const cancelHistoryTransaction = useCallback(() => {
    if (historyNoDataTimerRef.current !== null) {
      clearTimeout(historyNoDataTimerRef.current);
      historyNoDataTimerRef.current = null;
    }
    historyTransactionRef.current = null;
    setHistoryPhase('idle');
  }, [setHistoryPhase]);

  const restoreHistoryTransaction = useCallback(async () => {
    const transaction = historyTransactionRef.current;
    if (
      !aliveRef.current ||
      !transaction ||
      transaction.phase !== 'committed'
    ) {
      return;
    }

    setHistoryPhase('restoring');
    await waitForLayout();
    if (!aliveRef.current || historyTransactionRef.current !== transaction) {
      return;
    }

    const anchor = transaction.anchor;
    if (transaction.pinToPresent) {
      await scrollToPresentSettled(
        false,
        () => historyTransactionRef.current === transaction,
      );
    } else if (
      anchor &&
      !restoreAnchorOnce(anchor) &&
      !transaction.fallbackUsed
    ) {
      transaction.fallbackUsed = true;
      const index = messagesRef.current.findIndex(
        (message) => message.id === anchor.messageId,
      );
      if (index >= 0) {
        await listRef.current?.scrollToIndex({
          animated: false,
          index,
          viewOffset: -anchor.screenOffset,
          viewPosition: 0,
        });
      }
    }

    finishHistoryTransaction(transaction);
  }, [
    finishHistoryTransaction,
    listRef,
    restoreAnchorOnce,
    scrollToPresentSettled,
    setHistoryPhase,
  ]);

  const scheduleHistoryRestore = useCallback(() => {
    if (!aliveRef.current || historyRestoreFrameRef.current !== null) {
      return;
    }
    historyRestoreFrameRef.current = requestAnimationFrame(() => {
      historyRestoreFrameRef.current = null;
      if (aliveRef.current) {
        void restoreHistoryTransaction();
      }
    });
  }, [restoreHistoryTransaction]);

  const queueGeometryCorrection = useCallback(
    (anchorOverride?: VisibleAnchor | null) => {
      if (!geometryCorrectionRef.current) {
        const pinToPresent =
          stateRef.current.isAtPresent ||
          forceFollowOutputRef.current ||
          followMovementInFlightRef.current ||
          followIntentRef.current?.reason === 'jump-present';
        geometryCorrectionRef.current = {
          anchor: anchorOverride ?? captureVisibleAnchor(),
          highlightedMessageId: pinToPresent
            ? null
            : stateRef.current.highlightedMessageId,
          pinToPresent,
        };
      }

      if (geometryTimerRef.current !== null) {
        clearTimeout(geometryTimerRef.current);
      }

      geometryTimerRef.current = setTimeout(() => {
        geometryTimerRef.current = null;
        const correction = geometryCorrectionRef.current;
        geometryCorrectionRef.current = null;
        if (!correction) {
          return;
        }

        if (correction.highlightedMessageId) {
          const index = messagesRef.current.findIndex(
            (message) => message.id === correction.highlightedMessageId,
          );
          if (index >= 0) {
            void listRef.current?.scrollToIndex({
              animated: false,
              index,
              viewPosition: 0.5,
            });
          }
          return;
        }

        if (correction.pinToPresent) {
          void scrollToPresentSettled(
            false,
            () => !userInteractingRef.current,
          ).then(() => syncPositionState());
          return;
        }

        if (correction.anchor) {
          restoreAnchorOnce(correction.anchor);
        }
      }, 48);
    },
    [
      captureVisibleAnchor,
      listRef,
      restoreAnchorOnce,
      scrollToPresentSettled,
      syncPositionState,
    ],
  );

  const requestOlder = useCallback(async (): Promise<boolean> => {
    const loader = loadOlderRef.current;
    if (
      !loader ||
      !hasOlderRef.current ||
      loadingOlderRef.current ||
      loadingNewerRef.current ||
      newerRequestRef.current ||
      newerTransactionRef.current ||
      historyLoadPromiseRef.current ||
      historyTransactionRef.current ||
      jumpScrollPromiseRef.current ||
      stateRef.current.pendingJumpMessageId ||
      !initialRestoreCompleteRef.current ||
      Date.now() < historyCooldownUntilRef.current
    ) {
      return false;
    }

    const anchor = captureVisibleAnchor();
    const transaction: HistoryTransaction = {
      anchor,
      beforeFirstId: messagesRef.current[0]?.id ?? null,
      beforeLength: messagesRef.current.length,
      fallbackUsed: false,
      phase: 'captured',
      pinToPresent: stateRef.current.isAtPresent,
    };
    historyTransactionRef.current = transaction;
    setHistoryPhase('captured');
    setHistoryPhase('loading');

    const loaderPromise = Promise.resolve().then(loader);
    historyLoadPromiseRef.current = loaderPromise;
    try {
      await loaderPromise;
    } catch (error) {
      if (!aliveRef.current) {
        return false;
      }
      onLoadErrorRef.current?.('older', error);
      finishHistoryTransaction(transaction);
      return false;
    } finally {
      if (historyLoadPromiseRef.current === loaderPromise) {
        historyLoadPromiseRef.current = null;
      }
    }

    if (!aliveRef.current || historyTransactionRef.current !== transaction) {
      return false;
    }

    if (transaction.phase !== 'loading') {
      return true;
    }

    historyNoDataTimerRef.current = setTimeout(() => {
      historyNoDataTimerRef.current = null;
      const currentTransaction = historyTransactionRef.current;
      if (
        currentTransaction === transaction &&
        currentTransaction.phase === 'loading' &&
        currentTransaction.beforeFirstId ===
          (messagesRef.current[0]?.id ?? null) &&
        currentTransaction.beforeLength === messagesRef.current.length
      ) {
        finishHistoryTransaction(transaction);
      }
    }, 500);

    return true;
  }, [captureVisibleAnchor, finishHistoryTransaction, setHistoryPhase]);
  requestOlderRef.current = requestOlder;

  const requestNewer = useCallback(
    (loaderOverride?: () => Promise<void>): Promise<boolean> => {
      if (newerPromiseRef.current) {
        return newerPromiseRef.current;
      }

      const loader = loaderOverride ?? loadNewerRef.current;
      if (
        !loader ||
        !hasNewerRef.current ||
        loadingNewerRef.current ||
        newerTransactionRef.current ||
        loadingOlderRef.current ||
        historyLoadPromiseRef.current ||
        historyTransactionRef.current ||
        !initialRestoreCompleteRef.current
      ) {
        return Promise.resolve(false);
      }

      const transaction: NewerTransaction = {
        token: ++newerTransactionTokenRef.current,
      };
      newerTransactionRef.current = transaction;
      newerRequestRef.current = true;

      const promise = (async () => {
        try {
          await Promise.resolve();
          await loader();
          if (!aliveRef.current) {
            return false;
          }

          if (newerTransactionRef.current === transaction) {
            newerNoDataTimerRef.current = setTimeout(() => {
              newerNoDataTimerRef.current = null;
              if (newerTransactionRef.current === transaction) {
                newerTransactionRef.current = null;
              }
            }, 500);
          }
          return true;
        } catch (error) {
          if (aliveRef.current) {
            onLoadErrorRef.current?.('newer', error);
          }
          if (newerTransactionRef.current === transaction) {
            newerTransactionRef.current = null;
          }
          return false;
        } finally {
          newerRequestRef.current = false;
          newerPromiseRef.current = null;
        }
      })();

      newerPromiseRef.current = promise;
      return promise;
    },
    [],
  );

  const maybeLoadUnderfilled = useCallback(() => {
    if (
      !initialRestoreCompleteRef.current ||
      !hasOlderRef.current ||
      loadingOlderRef.current ||
      loadingNewerRef.current ||
      newerRequestRef.current ||
      newerTransactionRef.current ||
      historyLoadPromiseRef.current ||
      historyTransactionRef.current ||
      Date.now() < historyCooldownUntilRef.current ||
      (!isViewportUnderfilled(metricsRef.current) &&
        !isNearHistoryStart(metricsRef.current))
    ) {
      return;
    }

    const boundary = `${messagesRef.current[0]?.id ?? 'empty'}:${messagesRef.current.length}`;
    if (underfilledBoundaryRef.current === boundary) {
      return;
    }

    underfilledBoundaryRef.current = boundary;
    void requestOlderRef.current();
  }, []);

  const completeInitialRestore = useCallback(() => {
    if (
      initialRestoreCompleteRef.current ||
      initialRestoreInFlightRef.current ||
      !initialDataReadyRef.current ||
      !initialListLoadedRef.current ||
      metricsRef.current.viewportHeight <= 0
    ) {
      return;
    }

    initialRestoreInFlightRef.current = true;
    const restore = async () => {
      try {
        if (messagesRef.current.length > 0) {
          if (initialScrollToStartRef.current && !hasOlderRef.current) {
            listRef.current?.scrollToOffset({ animated: false, offset: 0 });
            await waitForLayout();
          } else {
            await scrollToPresentSettled(false);
          }
        }
      } catch {
        // FlashList may still be completing its first layout; state remains usable.
      }
      if (!aliveRef.current) return;
      initialRestoreInFlightRef.current = false;
      initialRestoreCompleteRef.current = true;
      patchState({
        initialRestoreComplete: true,
        isAtBeginning:
          !hasOlderRef.current && metricsRef.current.offsetY <= 12,
        isAtPresent:
          isPhysicallyAtPresent(metricsRef.current) && !hasNewerRef.current,
        showJumpToPresent: shouldShowJumpToPresent(
          metricsRef.current,
          hasNewerRef.current,
        ),
      });
      proactiveLoadTimerRef.current = setTimeout(() => {
        proactiveLoadTimerRef.current = null;
        maybeLoadUnderfilled();
      }, 0);
    };
    void restore();
  }, [listRef, maybeLoadUnderfilled, patchState, scrollToPresentSettled]);

  const onLoad = useCallback(() => {
    initialListLoadedRef.current = true;
    completeInitialRestore();
  }, [completeInitialRestore]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const previousHeight = metricsRef.current.viewportHeight;
      const nextHeight = event.nativeEvent.layout.height;
      const heightChanged =
        previousHeight > 0 && Math.abs(previousHeight - nextHeight) > 1;
      const preservedAnchor = viewportAnchorRef.current ?? visibleAnchorRef.current;

      metricsRef.current.viewportHeight = nextHeight;
      completeInitialRestore();

      if (heightChanged && initialRestoreCompleteRef.current) {
        viewportResizeHandledRef.current = true;
        queueGeometryCorrection(preservedAnchor);
      }
      viewportAnchorRef.current = null;
    },
    [completeInitialRestore, queueGeometryCorrection],
  );

  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      metricsRef.current.contentHeight = height;
      syncPositionState();
      completeInitialRestore();

      if (followIntentRef.current?.ready) {
        scheduleFollow(
          followIntentRef.current.reason,
          followIntentRef.current.animated,
        );
      }
      maybeLoadUnderfilled();
    },
    [completeInitialRestore, maybeLoadUnderfilled, scheduleFollow, syncPositionState],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      metricsRef.current.offsetY = Math.max(0, event.nativeEvent.contentOffset.y);
      metricsRef.current.contentHeight = event.nativeEvent.contentSize.height;
      metricsRef.current.viewportHeight = event.nativeEvent.layoutMeasurement.height;
      syncPositionState();

      const transaction = historyTransactionRef.current;
      if (
        userInteractingRef.current &&
        transaction &&
        (transaction.phase === 'captured' || transaction.phase === 'loading')
      ) {
        transaction.anchor = captureVisibleAnchor();
      }

      if (
        userInteractingRef.current &&
        geometryCorrectionRef.current &&
        !geometryCorrectionRef.current.highlightedMessageId &&
        !geometryCorrectionRef.current.pinToPresent
      ) {
        geometryCorrectionRef.current.anchor = captureVisibleAnchor();
      }
    },
    [captureVisibleAnchor, syncPositionState],
  );

  const onScrollBeginDrag = useCallback(() => {
    userInteractingRef.current = true;
    if (stateRef.current.highlightedMessageId) {
      clearHighlightTimer();
      patchState({ highlightedMessageId: null });
    }
    if (geometryCorrectionRef.current?.highlightedMessageId) {
      geometryCorrectionRef.current.highlightedMessageId = null;
      geometryCorrectionRef.current.pinToPresent = false;
      geometryCorrectionRef.current.anchor = captureVisibleAnchor();
    }
    if (
      followIntentRef.current?.reason === 'append-present' ||
      activeFollowReasonRef.current === 'append-present'
    ) {
      cancelAppendFollowMovement();
    }
  }, [cancelAppendFollowMovement, captureVisibleAnchor, clearHighlightTimer, patchState]);

  const onScrollEndDrag = useCallback(() => {
    userInteractingRef.current = false;
  }, []);

  const onMomentumScrollBegin = useCallback(() => {
    userInteractingRef.current = true;
  }, []);

  const onMomentumScrollEnd = useCallback(() => {
    userInteractingRef.current = false;
  }, []);

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
      if (!first || !last) {
        visibleAnchorRef.current = null;
        onVisibleRangeChangeRef.current?.({
          firstMessageId: null,
          lastMessageId: null,
          firstIndex: null,
          lastIndex: null,
        });
        return;
      }

      const layout = listRef.current?.getLayout(first.index);
      visibleAnchorRef.current = {
        messageId: first.item.id,
        index: first.index,
        screenOffset: layout
          ? layout.y - metricsRef.current.offsetY
          : visibleAnchorRef.current?.screenOffset ?? 0,
      };

      onVisibleRangeChangeRef.current?.({
        firstMessageId: first.item.id,
        lastMessageId: last.item.id,
        firstIndex: first.index,
        lastIndex: last.index,
      });
    },
    [listRef],
  );

  const onCommitLayoutEffect = useCallback(() => {
    if (historyTransactionRef.current?.phase === 'committed') {
      scheduleHistoryRestore();
    }

    if (followIntentRef.current?.ready) {
      scheduleFollow(
        followIntentRef.current.reason,
        followIntentRef.current.animated,
      );
    }
  }, [scheduleFollow, scheduleHistoryRestore]);

  const jumpToMessage = useCallback(
    async (
      messageId: string,
      options: JumpToMessageOptions = {},
    ): Promise<boolean> => {
      const generation = ++jumpGenerationRef.current;
      const olderLoad = historyLoadPromiseRef.current;
      cancelFollowMovement();
      cancelHistoryTransaction();
      clearHighlightTimer();
      patchState({
        highlightedMessageId: null,
        pendingJumpMessageId: messageId,
      });

      const priorScroll = jumpScrollPromiseRef.current;
      if (priorScroll) {
        await priorScroll;
      }
      if (olderLoad) {
        try {
          await olderLoad;
        } catch {
          // The history request owns its error reporting.
        }
        await waitForLayout();
      }
      if (!aliveRef.current || generation !== jumpGenerationRef.current) {
        return false;
      }

      const index = messagesRef.current.findIndex(
        (message) => message.id === messageId,
      );
      if (index < 0) {
        patchState({ pendingJumpMessageId: null });
        return false;
      }

      const scrollPromise = scrollToIndexBounded(
        index,
        options.animated ?? true,
      );
      jumpScrollPromiseRef.current = scrollPromise;
      const succeeded = await scrollPromise;
      if (jumpScrollPromiseRef.current === scrollPromise) {
        jumpScrollPromiseRef.current = null;
      }
      if (!aliveRef.current || generation !== jumpGenerationRef.current) {
        return false;
      }
      patchState({ pendingJumpMessageId: null });
      if (succeeded) {
        startHighlight(messageId);
      }
      return succeeded;
    },
    [
      cancelFollowMovement,
      cancelHistoryTransaction,
      clearHighlightTimer,
      patchState,
      scrollToIndexBounded,
      startHighlight,
    ],
  );

  const jumpToPresent = useCallback(
    async (options: JumpToPresentOptions = {}): Promise<void> => {
      const olderLoad = historyLoadPromiseRef.current;
      const targetScroll = jumpScrollPromiseRef.current;
      jumpGenerationRef.current += 1;
      cancelFollowMovement();
      cancelHistoryTransaction();
      clearHighlightTimer();
      patchState({
        highlightedMessageId: null,
        pendingJumpMessageId: null,
      });
      followIntentRef.current = {
        animated: options.animated ?? true,
        ready: false,
        reason: 'jump-present',
      };

      if (targetScroll) {
        await targetScroll;
        if (!aliveRef.current) {
          return;
        }
      }

      if (olderLoad) {
        try {
          await olderLoad;
        } catch {
          // The older-load owner reports its own error.
        }
        await waitForLayout();
      }

      if (!aliveRef.current) {
        return;
      }

      if (hasNewerRef.current) {
        if (newerPromiseRef.current) {
          await newerPromiseRef.current;
          await waitForLayout(520);
        }

        if (hasNewerRef.current) {
          const latestLoader = loadLatestRef.current;
          if (!latestLoader) {
            followIntentRef.current = null;
            return;
          }

          let reachedLatest = await requestNewer(latestLoader);
          if (!reachedLatest && loadingOlderRef.current) {
            await waitForLayout();
            reachedLatest = await requestNewer(latestLoader);
          }
          if (!reachedLatest) {
            followIntentRef.current = null;
            return;
          }
        }
        const latestCommitted = await waitForLatestCommit();
        if (!latestCommitted) {
          followIntentRef.current = null;
          return;
        }
        await waitForLayout();
      }

      if (followIntentRef.current?.reason === 'jump-present') {
        scheduleFollow('jump-present', options.animated ?? true, true);
      }
    },
    [
      cancelFollowMovement,
      cancelHistoryTransaction,
      clearHighlightTimer,
      patchState,
      requestNewer,
      scheduleFollow,
      waitForLatestCommit,
    ],
  );

  const onStartReached = useCallback(() => {
    void requestOlderRef.current();
  }, []);

  const onEndReached = useCallback(() => {
    if (hasNewerRef.current) {
      void requestNewer();
    }
  }, [requestNewer]);

  const onItemHeightWillChange = useCallback(() => {
    queueGeometryCorrection();
  }, [queueGeometryCorrection]);

  useLayoutEffect(() => {
    const previous = previousMessagesRef.current;
    previousMessagesRef.current = messages;

    const previousById = new Map(previous.map((message) => [message.id, message]));
    const stableRowGeometryChanged = messages.some((message) => {
      const prior = previousById.get(message.id);
      return (
        prior &&
        (prior.layoutVersion !== message.layoutVersion ||
          prior.text !== message.text ||
          prior.image?.uri !== message.image?.uri ||
          prior.image?.width !== message.image?.width ||
          prior.image?.height !== message.image?.height)
      );
    });
    if (stableRowGeometryChanged) {
      queueGeometryCorrection();
    }

    const previousLastId = previous[previous.length - 1]?.id;
    const previousLastIndex = previousLastId
      ? messages.findIndex((message) => message.id === previousLastId)
      : -1;
    const appended =
      previousLastIndex >= 0 && previousLastIndex < messages.length - 1
        ? messages.slice(previousLastIndex + 1)
        : [];

    const newerTransaction = newerTransactionRef.current;

    const forceFollowPredicate = shouldForceFollowOnAppendRef.current;
    const includesForcedOwnOutput = appended.some((message) =>
      forceFollowPredicate
        ? forceFollowPredicate(message)
        : !newerTransaction &&
          message.senderId === currentUserIdRef.current,
    );

    const transaction = historyTransactionRef.current;
    const priorFirstIndex = transaction?.beforeFirstId
      ? messages.findIndex(
          (message) => message.id === transaction.beforeFirstId,
        )
      : -1;
    const didCommitPrepend = Boolean(
      transaction?.phase === 'loading' &&
        ((transaction.beforeFirstId !== null && priorFirstIndex > 0) ||
          (transaction.beforeFirstId === null &&
            transaction.beforeLength === 0 &&
            messages.length > 0)),
    );

    if (didCommitPrepend && transaction) {
      if (includesForcedOwnOutput) {
        transaction.pinToPresent = true;
      }
      if (historyNoDataTimerRef.current !== null) {
        clearTimeout(historyNoDataTimerRef.current);
        historyNoDataTimerRef.current = null;
      }
      setHistoryPhase('committed');
      scheduleHistoryRestore();
      return;
    }

    if (previous.length === 0 && messages.length > 0) {
      if (initialRestoreCompleteRef.current) {
        scheduleFollow('append-present', false);
      }
      return;
    }

    if (appended.length === 0) {
      return;
    }

    if (includesForcedOwnOutput) {
      if (transaction) {
        transaction.pinToPresent = true;
      }
      scheduleFollow('own-message', true);
    } else if (
      !newerTransaction &&
      !userInteractingRef.current &&
      stateRef.current.isAtPresent
    ) {
      scheduleFollow('append-present', true);
    }
  }, [
    messages,
    queueGeometryCorrection,
    scheduleFollow,
    scheduleHistoryRestore,
    setHistoryPhase,
  ]);

  useEffect(() => {
    syncPositionState();
    if (!hasNewer) {
      resolveLatestCommitWaiters(true);
      if (newerTransactionRef.current) {
        newerTransactionRef.current = null;
        if (newerNoDataTimerRef.current !== null) {
          clearTimeout(newerNoDataTimerRef.current);
          newerNoDataTimerRef.current = null;
        }
      }
    }
  }, [hasNewer, hasOlder, resolveLatestCommitWaiters, syncPositionState]);

  useEffect(() => {
    completeInitialRestore();
  }, [completeInitialRestore, initialDataReady]);

  useEffect(() => {
    patchState({
      isLoadingHistory:
        loadingOlder || historyTransactionRef.current !== null,
    });
  }, [loadingOlder, patchState]);

  useEffect(() => {
    onStateChange?.(state);
  }, [onStateChange, state]);

  useEffect(() => {
    const captureViewportAnchor = () => {
      viewportAnchorRef.current = captureVisibleAnchor();
    };
    const willChange = Keyboard.addListener(
      'keyboardWillChangeFrame',
      captureViewportAnchor,
    );
    const didShow = Keyboard.addListener('keyboardDidShow', () => {
      if (viewportResizeHandledRef.current) {
        viewportResizeHandledRef.current = false;
        return;
      }
      if (!geometryCorrectionRef.current) {
        queueGeometryCorrection(viewportAnchorRef.current ?? visibleAnchorRef.current);
      }
    });
    const didHide = Keyboard.addListener('keyboardDidHide', () => {
      if (viewportResizeHandledRef.current) {
        viewportResizeHandledRef.current = false;
        return;
      }
      if (!geometryCorrectionRef.current) {
        queueGeometryCorrection(viewportAnchorRef.current ?? visibleAnchorRef.current);
      }
    });

    return () => {
      willChange.remove();
      didShow.remove();
      didHide.remove();
    };
  }, [captureVisibleAnchor, queueGeometryCorrection]);

  useEffect(() => {
    aliveRef.current = true;
    if (initialRestoreCompleteRef.current) {
      proactiveLoadTimerRef.current = setTimeout(() => {
        proactiveLoadTimerRef.current = null;
        maybeLoadUnderfilled();
      }, 0);
    }
    return () => {
      aliveRef.current = false;
      resolveLatestCommitWaiters(false);
      if (followFrameRef.current !== null) {
        cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = null;
      }
      if (historyRestoreFrameRef.current !== null) {
        cancelAnimationFrame(historyRestoreFrameRef.current);
        historyRestoreFrameRef.current = null;
      }
      followSettleGenerationRef.current += 1;
      activeFollowReasonRef.current = null;
      followMovementInFlightRef.current = false;
      initialRestoreInFlightRef.current = false;
      if (geometryTimerRef.current !== null) {
        clearTimeout(geometryTimerRef.current);
        geometryTimerRef.current = null;
      }
      if (historyNoDataTimerRef.current !== null) {
        clearTimeout(historyNoDataTimerRef.current);
        historyNoDataTimerRef.current = null;
      }
      if (newerNoDataTimerRef.current !== null) {
        clearTimeout(newerNoDataTimerRef.current);
        newerNoDataTimerRef.current = null;
      }
      if (highlightTimerRef.current !== null) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
      if (proactiveLoadTimerRef.current !== null) {
        clearTimeout(proactiveLoadTimerRef.current);
        proactiveLoadTimerRef.current = null;
      }
    };
  }, [maybeLoadUnderfilled, resolveLatestCommitWaiters]);

  return {
    jumpToMessage,
    jumpToPresent,
    maybeLoadUnderfilled,
    onCommitLayoutEffect,
    onContentSizeChange,
    onEndReached,
    onItemHeightWillChange,
    onLayout,
    onLoad,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onStartReached,
    onViewableItemsChanged,
    requestOlder,
    state,
    stateRef,
  };
}
