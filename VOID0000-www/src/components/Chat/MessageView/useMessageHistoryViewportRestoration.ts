import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import {
  getFirstVisibleMessageAnchor,
  getMessageAnchorsAroundViewport,
  getMessageElementEdgeOffset,
  moveHistoryRangeReplacementSeamAnchor,
  restoreHistoryRangeReplacementAnchor,
  restoreHistoryRangeReplacementSeamAnchor,
  restoreVisibleMessageAnchor,
  shouldCaptureHistoryRangeReplacement,
  shouldPreferVisibleHistoryRangeAnchor,
  shouldRestoreOlderHistoryByScrollHeight,
  updateHistoryLoadMessageAnchor,
  updateHistoryRangeReplacementPosition,
  type HistoryLoadScrollSnapshot,
  type HistoryRangeReplacementSnapshot,
  type NewerHistoryLoadScrollSnapshot,
  type ViewportAnchorLock,
} from './historyScrollAnchors';
import {
  captureMessageTimelineGeometry,
  isMessageGeometryDiagnosticsEnabled,
  recordMessageGeometryEvent,
} from './messageGeometryDiagnostics';

const OLDER_LOAD_SCROLL_UPDATE_THRESHOLD = 1;

const summarizeHistorySnapshot = (
  snapshot: HistoryLoadScrollSnapshot | NewerHistoryLoadScrollSnapshot | null,
) => snapshot ? {
  scrollHeight: snapshot.scrollHeight,
  scrollTop: snapshot.scrollTop,
  anchorMessageId: snapshot.anchorMessageId,
  anchorOffsetTop: snapshot.anchorOffsetTop,
  readyToRestore: snapshot.readyToRestore,
  rangeReplacement: snapshot.rangeReplacement ? {
    direction: snapshot.rangeReplacement.direction,
    seamMessageId: snapshot.rangeReplacement.seamMessageId,
    mapped: snapshot.rangeReplacement.mapped,
    sourceStart: snapshot.rangeReplacement.sourceStart,
    sourceEnd: snapshot.rangeReplacement.sourceEnd,
    anchor: snapshot.rangeReplacement.anchor,
  } : null,
} : null;

interface ScrollState {
  atBottom: boolean;
  shouldShowJumpToPresent: boolean;
  isAtPresent: boolean;
}

interface UseMessageHistoryViewportRestorationOptions {
  resetKey: string;
  scrollerRef: RefObject<HTMLDivElement | null>;
  firstVisualMessageId?: string;
  lastVisualMessageId?: string;
  renderedTopSpacerHeight: number;
  renderedBottomSpacerHeight: number;
  historyLogicalSlotHeight: number;
  historySkeletonRowHeight: number;
  olderTopExhaustionThreshold: number;
  hasNewer: boolean;
  pendingOlderLoadScrollSnapshotRef: MutableRefObject<HistoryLoadScrollSnapshot | null>;
  pendingNewerLoadScrollSnapshotRef: MutableRefObject<NewerHistoryLoadScrollSnapshot | null>;
  historyScrollTransactionActiveRef: MutableRefObject<boolean>;
  viewportAnchorLockRef: MutableRefObject<ViewportAnchorLock | null>;
  viewportAnchorRestoreInProgressRef: MutableRefObject<boolean>;
  atBottomRef: MutableRefObject<boolean>;
  showJumpToPresentRef: MutableRefObject<boolean>;
  forceFollowOutputRef: MutableRefObject<boolean>;
  hasOlderRef: MutableRefObject<boolean>;
  hasNewerRef: MutableRefObject<boolean>;
  historyLoadPausedUntilRef: MutableRefObject<number>;
  isOlderRangeVisible: (scroller: HTMLElement) => boolean;
  isNewerRangeVisible: (scroller: HTMLElement) => boolean;
  getScrollState: (scroller: HTMLElement) => ScrollState;
  captureViewportAnchorLock: (scroller?: HTMLDivElement | null) => boolean;
  loadOlder: () => Promise<boolean | undefined>;
  loadNewer: () => Promise<boolean | undefined>;
  setOlderRangeError: (value: boolean) => void;
  setNewerRangeError: (value: boolean) => void;
  setShowJumpToPresent: (value: boolean) => void;
  setIsAtPresent: (value: boolean) => void;
  onOwnSendHistoryModeChange?: (shouldJumpToPresent: boolean) => void;
}

export function useMessageHistoryViewportRestoration({
  resetKey,
  scrollerRef,
  firstVisualMessageId,
  lastVisualMessageId,
  renderedTopSpacerHeight,
  renderedBottomSpacerHeight,
  historyLogicalSlotHeight,
  historySkeletonRowHeight,
  olderTopExhaustionThreshold,
  hasNewer,
  pendingOlderLoadScrollSnapshotRef,
  pendingNewerLoadScrollSnapshotRef,
  historyScrollTransactionActiveRef,
  viewportAnchorLockRef,
  viewportAnchorRestoreInProgressRef,
  atBottomRef,
  showJumpToPresentRef,
  forceFollowOutputRef,
  hasOlderRef,
  hasNewerRef,
  historyLoadPausedUntilRef,
  isOlderRangeVisible,
  isNewerRangeVisible,
  getScrollState,
  captureViewportAnchorLock,
  loadOlder,
  loadNewer,
  setOlderRangeError,
  setNewerRangeError,
  setShowJumpToPresent,
  setIsAtPresent,
  onOwnSendHistoryModeChange,
}: UseMessageHistoryViewportRestorationOptions) {
  const [historyRestoreRevision, setHistoryRestoreRevision] = useState(0);
  const historyTransactionReleaseFrameRef = useRef<number | null>(null);

  const cancelHistoryTransactionRelease = useCallback(() => {
    if (historyTransactionReleaseFrameRef.current === null) {
      return;
    }
    cancelAnimationFrame(historyTransactionReleaseFrameRef.current);
    historyTransactionReleaseFrameRef.current = null;
  }, []);

  const releaseHistoryTransactionAfterScrollEvent = useCallback(() => {
    cancelHistoryTransactionRelease();
    historyScrollTransactionActiveRef.current = true;
    historyTransactionReleaseFrameRef.current = requestAnimationFrame(() => {
      historyTransactionReleaseFrameRef.current = null;
      if (
        !pendingOlderLoadScrollSnapshotRef.current &&
        !pendingNewerLoadScrollSnapshotRef.current
      ) {
        historyScrollTransactionActiveRef.current = false;
        recordMessageGeometryEvent('history_transaction_finished', () => ({
          resetKey,
          timeline: captureMessageTimelineGeometry(scrollerRef.current),
        }));
      }
    });
  }, [
    cancelHistoryTransactionRelease,
    historyScrollTransactionActiveRef,
    pendingNewerLoadScrollSnapshotRef,
    pendingOlderLoadScrollSnapshotRef,
    resetKey,
    scrollerRef,
  ]);

  useEffect(() => {
    cancelHistoryTransactionRelease();
  }, [cancelHistoryTransactionRelease, resetKey]);

  useEffect(() => cancelHistoryTransactionRelease, [cancelHistoryTransactionRelease]);

  const captureHistoryLoadScrollSnapshot = useCallback((): HistoryLoadScrollSnapshot | null => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const visibleMessageAnchor = getFirstVisibleMessageAnchor(scroller);
    const shouldMapVisibleRange = Boolean(
      firstVisualMessageId &&
      renderedTopSpacerHeight > 1 &&
      shouldCaptureHistoryRangeReplacement({
        historyRangeVisible: isOlderRangeVisible(scroller),
        hasVisibleMessageAnchor: Boolean(visibleMessageAnchor),
      }),
    );
    const rangeReplacement: HistoryRangeReplacementSnapshot | null = shouldMapVisibleRange
      ? {
          direction: 'older',
          seamMessageId: firstVisualMessageId!,
          seamAnchor: (() => {
            const offset = getMessageElementEdgeOffset(scroller, firstVisualMessageId!, 'top');
            return offset === null ? null : { edge: 'top', offset };
          })(),
          sourceStart: Math.max(0, renderedTopSpacerHeight - historyLogicalSlotHeight),
          sourceEnd: renderedTopSpacerHeight,
          rowHeight: historySkeletonRowHeight,
          anchor: {
            kind: 'start',
            offsetTop: 0,
          },
          rangeStartOffsetTop: 0,
          rangeEndOffsetTop: 0,
          mapped: false,
        }
      : null;
    if (rangeReplacement) {
      updateHistoryRangeReplacementPosition(scroller, rangeReplacement);
    }
    const anchor = rangeReplacement ? null : visibleMessageAnchor;

    const snapshot = {
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      anchorMessageId: anchor?.messageId ?? null,
      anchorOffsetTop: anchor?.offsetTop ?? null,
      rangeReplacement,
      readyToRestore: false,
    };
    pendingOlderLoadScrollSnapshotRef.current = snapshot;
    cancelHistoryTransactionRelease();
    historyScrollTransactionActiveRef.current = true;
    if (rangeReplacement) {
      viewportAnchorLockRef.current = null;
    } else {
      captureViewportAnchorLock(scroller);
    }
    recordMessageGeometryEvent('history_load_begin', () => ({
      resetKey,
      direction: 'older',
      snapshot: summarizeHistorySnapshot(snapshot),
      timeline: captureMessageTimelineGeometry(scroller, {
        renderedTopSpacerHeight,
        renderedBottomSpacerHeight,
      }),
    }));
    return snapshot;
  }, [
    captureViewportAnchorLock,
    cancelHistoryTransactionRelease,
    firstVisualMessageId,
    historyLogicalSlotHeight,
    historyScrollTransactionActiveRef,
    historySkeletonRowHeight,
    isOlderRangeVisible,
    pendingOlderLoadScrollSnapshotRef,
    renderedBottomSpacerHeight,
    renderedTopSpacerHeight,
    resetKey,
    scrollerRef,
    viewportAnchorLockRef,
  ]);

  const captureNewerHistoryLoadScrollSnapshot = useCallback((): NewerHistoryLoadScrollSnapshot | null => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const visibleMessageAnchor = getFirstVisibleMessageAnchor(scroller);
    const shouldMapVisibleRange = Boolean(
      lastVisualMessageId &&
      renderedBottomSpacerHeight > 1 &&
      shouldCaptureHistoryRangeReplacement({
        historyRangeVisible: isNewerRangeVisible(scroller),
        hasVisibleMessageAnchor: Boolean(visibleMessageAnchor),
      }),
    );
    const bottomRangeStart = scroller.scrollHeight - renderedBottomSpacerHeight;
    const rangeReplacement: HistoryRangeReplacementSnapshot | null = shouldMapVisibleRange
      ? {
          direction: 'newer',
          seamMessageId: lastVisualMessageId!,
          seamAnchor: (() => {
            const offset = getMessageElementEdgeOffset(scroller, lastVisualMessageId!, 'bottom');
            return offset === null ? null : { edge: 'bottom', offset };
          })(),
          sourceStart: bottomRangeStart,
          sourceEnd: Math.min(
            scroller.scrollHeight,
            bottomRangeStart + historyLogicalSlotHeight,
          ),
          rowHeight: historySkeletonRowHeight,
          anchor: {
            kind: 'start',
            offsetTop: 0,
          },
          rangeStartOffsetTop: 0,
          rangeEndOffsetTop: 0,
          mapped: false,
        }
      : null;
    if (rangeReplacement) {
      updateHistoryRangeReplacementPosition(scroller, rangeReplacement);
    }
    const anchors = rangeReplacement ? [] : getMessageAnchorsAroundViewport(scroller);
    const anchor = anchors[0] ?? null;

    const snapshot = {
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      anchorMessageId: anchor?.messageId ?? null,
      anchorOffsetTop: anchor?.offsetTop ?? null,
      rangeReplacement,
      readyToRestore: false,
      fallbackAnchors: anchors.slice(1),
      distanceFromBottom: scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight),
    };
    pendingNewerLoadScrollSnapshotRef.current = snapshot;
    cancelHistoryTransactionRelease();
    historyScrollTransactionActiveRef.current = true;
    if (rangeReplacement) {
      viewportAnchorLockRef.current = null;
    } else {
      captureViewportAnchorLock(scroller);
    }
    recordMessageGeometryEvent('history_load_begin', () => ({
      resetKey,
      direction: 'newer',
      snapshot: summarizeHistorySnapshot(snapshot),
      timeline: captureMessageTimelineGeometry(scroller, {
        renderedTopSpacerHeight,
        renderedBottomSpacerHeight,
      }),
    }));
    return snapshot;
  }, [
    captureViewportAnchorLock,
    cancelHistoryTransactionRelease,
    historyLogicalSlotHeight,
    historyScrollTransactionActiveRef,
    historySkeletonRowHeight,
    isNewerRangeVisible,
    lastVisualMessageId,
    pendingNewerLoadScrollSnapshotRef,
    renderedTopSpacerHeight,
    renderedBottomSpacerHeight,
    resetKey,
    scrollerRef,
    viewportAnchorLockRef,
  ]);

  const syncScrollState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const pendingOlderSnapshot = pendingOlderLoadScrollSnapshotRef.current;
    if (
      pendingOlderSnapshot &&
      Math.abs(scroller.scrollHeight - pendingOlderSnapshot.scrollHeight) <= OLDER_LOAD_SCROLL_UPDATE_THRESHOLD
    ) {
      const scrollDelta = scroller.scrollTop - pendingOlderSnapshot.scrollTop;
      pendingOlderSnapshot.scrollTop = scroller.scrollTop;
      if (pendingOlderSnapshot.rangeReplacement) {
        moveHistoryRangeReplacementSeamAnchor(pendingOlderSnapshot.rangeReplacement, scrollDelta);
        updateHistoryRangeReplacementPosition(scroller, pendingOlderSnapshot.rangeReplacement);
      } else {
        const anchor = getFirstVisibleMessageAnchor(scroller);
        // Once the reader has moved fully into unloaded history, the old seam
        // row is no longer a trustworthy viewport anchor. Let restoration use
        // the latest scrollTop plus the committed scroll-height delta instead.
        updateHistoryLoadMessageAnchor(pendingOlderSnapshot, anchor);
      }
    }

    const pendingNewerSnapshot = pendingNewerLoadScrollSnapshotRef.current;
    if (
      pendingNewerSnapshot &&
      Math.abs(scroller.scrollHeight - pendingNewerSnapshot.scrollHeight) <= OLDER_LOAD_SCROLL_UPDATE_THRESHOLD
    ) {
      const scrollDelta = scroller.scrollTop - pendingNewerSnapshot.scrollTop;
      pendingNewerSnapshot.scrollTop = scroller.scrollTop;
      pendingNewerSnapshot.distanceFromBottom =
        scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
      if (pendingNewerSnapshot.rangeReplacement) {
        moveHistoryRangeReplacementSeamAnchor(pendingNewerSnapshot.rangeReplacement, scrollDelta);
        updateHistoryRangeReplacementPosition(scroller, pendingNewerSnapshot.rangeReplacement);
      } else {
        const anchors = getMessageAnchorsAroundViewport(scroller);
        const anchor = anchors[0];
        if (anchor) {
          pendingNewerSnapshot.anchorMessageId = anchor.messageId;
          pendingNewerSnapshot.anchorOffsetTop = anchor.offsetTop;
          pendingNewerSnapshot.fallbackAnchors = anchors.slice(1);
        } else {
          if (pendingNewerSnapshot.anchorOffsetTop !== null) {
            pendingNewerSnapshot.anchorOffsetTop -= scrollDelta;
          }
          pendingNewerSnapshot.fallbackAnchors = pendingNewerSnapshot.fallbackAnchors.map(
            (fallbackAnchor) => ({
              ...fallbackAnchor,
              offsetTop: fallbackAnchor.offsetTop - scrollDelta,
            }),
          );
        }
      }
    }

    const scrollState = getScrollState(scroller);

    atBottomRef.current = scrollState.atBottom;
    showJumpToPresentRef.current = scrollState.shouldShowJumpToPresent;
    setShowJumpToPresent(scrollState.shouldShowJumpToPresent);
    // Scrolling within the latest loaded page does not require a page reload on
    // send. Only an actual unloaded newer range needs the server-backed jump.
    onOwnSendHistoryModeChange?.(hasNewer || renderedBottomSpacerHeight > 1);

    if (scrollState.atBottom) {
      forceFollowOutputRef.current = false;
      if (!historyScrollTransactionActiveRef.current) {
        viewportAnchorLockRef.current = null;
      }
    } else if (!viewportAnchorRestoreInProgressRef.current) {
      captureViewportAnchorLock(scroller);
    }

    setIsAtPresent(scrollState.isAtPresent);
  }, [
    atBottomRef,
    captureViewportAnchorLock,
    forceFollowOutputRef,
    getScrollState,
    hasNewer,
    historyScrollTransactionActiveRef,
    onOwnSendHistoryModeChange,
    pendingNewerLoadScrollSnapshotRef,
    pendingOlderLoadScrollSnapshotRef,
    renderedBottomSpacerHeight,
    scrollerRef,
    setIsAtPresent,
    setShowJumpToPresent,
    showJumpToPresentRef,
    viewportAnchorLockRef,
    viewportAnchorRestoreInProgressRef,
  ]);

  const restoreHistoryLoadScrollSnapshot = useCallback((snapshot: HistoryLoadScrollSnapshot) => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return false;
    }

    const before = isMessageGeometryDiagnosticsEnabled()
      ? captureMessageTimelineGeometry(scroller)
      : null;
    const finishRestore = (strategy: string, restored: boolean) => {
      recordMessageGeometryEvent('history_anchor_restore', () => ({
        resetKey,
        direction: 'older',
        strategy,
        restored,
        snapshot: summarizeHistorySnapshot(snapshot),
        before,
        after: captureMessageTimelineGeometry(scroller),
      }));
      return restored;
    };

    const scrollHeightDelta = scroller.scrollHeight - snapshot.scrollHeight;
    if (
      shouldRestoreOlderHistoryByScrollHeight(snapshot) &&
      Math.abs(scrollHeightDelta) > 0.5
    ) {
      scroller.scrollTop = Math.max(0, snapshot.scrollTop + scrollHeightDelta);
      syncScrollState();
      return finishRestore('scroll_height_delta_without_anchor', true);
    }

    const replacement = snapshot.rangeReplacement;
    if (replacement) {
      if (!replacement.mapped) {
        const messageElements = Array.from(
          scroller.querySelectorAll<HTMLElement>('[data-message-id]'),
        );
        const seamIndex = messageElements.findIndex(
          (element) => element.dataset.messageId === replacement.seamMessageId,
        );

        if (seamIndex > 0) {
          const insertedElements = messageElements.slice(0, seamIndex);
          const firstInsertedElement = insertedElements[0]!;
          const seamElement = messageElements[seamIndex]!;
          const scrollerRect = scroller.getBoundingClientRect();
          const shouldMapVisibleRange = shouldPreferVisibleHistoryRangeAnchor(replacement);
          if (
            shouldMapVisibleRange ||
            !restoreHistoryRangeReplacementSeamAnchor(scroller, replacement)
          ) {
            restoreHistoryRangeReplacementAnchor({
              scroller,
              replacement,
              insertedElements,
              rangeStartOffsetTop:
                firstInsertedElement.getBoundingClientRect().top - scrollerRect.top,
              rangeEndOffsetTop:
                seamElement.getBoundingClientRect().top - scrollerRect.top,
            });
          }
        } else if (snapshot.readyToRestore && !hasOlderRef.current) {
          scroller.scrollTop = 0;
          replacement.mapped = true;
        }
      }

      if (replacement.mapped) {
        syncScrollState();
        return finishRestore('range_replacement', true);
      }

      return finishRestore('range_replacement_waiting_for_rows', false);
    }

    if (!hasOlderRef.current && snapshot.scrollTop <= olderTopExhaustionThreshold) {
      scroller.scrollTop = 0;
      syncScrollState();
      return finishRestore('older_range_exhausted', true);
    }

    if (restoreVisibleMessageAnchor(scroller, snapshot)) {
      syncScrollState();
      return finishRestore('visible_message_anchor', true);
    }

    if (Math.abs(scrollHeightDelta) > 0.5) {
      scroller.scrollTop = snapshot.scrollTop + scrollHeightDelta;
      syncScrollState();
      return finishRestore('scroll_height_delta_fallback', true);
    }

    syncScrollState();
    return finishRestore('no_geometry_delta', true);
  }, [hasOlderRef, olderTopExhaustionThreshold, resetKey, scrollerRef, syncScrollState]);

  const restoreNewerHistoryLoadScrollSnapshot = useCallback((snapshot: NewerHistoryLoadScrollSnapshot) => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return false;
    }

    const before = isMessageGeometryDiagnosticsEnabled()
      ? captureMessageTimelineGeometry(scroller)
      : null;
    const finishRestore = (strategy: string, restored: boolean) => {
      recordMessageGeometryEvent('history_anchor_restore', () => ({
        resetKey,
        direction: 'newer',
        strategy,
        restored,
        snapshot: summarizeHistorySnapshot(snapshot),
        before,
        after: captureMessageTimelineGeometry(scroller),
      }));
      return restored;
    };

    const replacement = snapshot.rangeReplacement;
    if (replacement) {
      if (!replacement.mapped) {
        const messageElements = Array.from(
          scroller.querySelectorAll<HTMLElement>('[data-message-id]'),
        );
        const seamIndex = messageElements.findIndex(
          (element) => element.dataset.messageId === replacement.seamMessageId,
        );

        if (seamIndex >= 0 && seamIndex < messageElements.length - 1) {
          const seamElement = messageElements[seamIndex]!;
          const insertedElements = messageElements.slice(seamIndex + 1);
          const lastInsertedElement = insertedElements[insertedElements.length - 1]!;
          const scrollerRect = scroller.getBoundingClientRect();
          const shouldMapVisibleRange = shouldPreferVisibleHistoryRangeAnchor(replacement);
          if (
            shouldMapVisibleRange ||
            !restoreHistoryRangeReplacementSeamAnchor(scroller, replacement)
          ) {
            restoreHistoryRangeReplacementAnchor({
              scroller,
              replacement,
              insertedElements,
              rangeStartOffsetTop:
                seamElement.getBoundingClientRect().bottom - scrollerRect.top,
              rangeEndOffsetTop:
                lastInsertedElement.getBoundingClientRect().bottom - scrollerRect.top,
            });
          }
        } else if (snapshot.readyToRestore && !hasNewerRef.current) {
          scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          replacement.mapped = true;
        }
      }

      if (replacement.mapped) {
        syncScrollState();
        return finishRestore('range_replacement', true);
      }

      return finishRestore('range_replacement_waiting_for_rows', false);
    }

    if (restoreVisibleMessageAnchor(scroller, snapshot)) {
      syncScrollState();
      return finishRestore('visible_message_anchor', true);
    }

    for (const anchor of snapshot.fallbackAnchors) {
      if (restoreVisibleMessageAnchor(scroller, {
        anchorMessageId: anchor.messageId,
        anchorOffsetTop: anchor.offsetTop,
      })) {
        syncScrollState();
        return finishRestore('fallback_visible_message_anchor', true);
      }
    }

    scroller.scrollTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight - snapshot.distanceFromBottom,
    );
    syncScrollState();
    return finishRestore('distance_from_bottom_fallback', true);
  }, [hasNewerRef, resetKey, scrollerRef, syncScrollState]);

  const loadOlderPreservingViewport = useCallback(async () => {
    const snapshot = captureHistoryLoadScrollSnapshot();
    const didLoad = await loadOlder();
    recordMessageGeometryEvent('history_load_resolved', () => ({
      resetKey,
      direction: 'older',
      didLoad: Boolean(didLoad),
      snapshot: summarizeHistorySnapshot(snapshot),
      timeline: captureMessageTimelineGeometry(scrollerRef.current),
    }));
    const isHistoryPaused = historyLoadPausedUntilRef.current > Date.now();
    setOlderRangeError(didLoad === false && !isHistoryPaused);
    if (didLoad && snapshot && pendingOlderLoadScrollSnapshotRef.current === snapshot) {
      snapshot.readyToRestore = true;
      setHistoryRestoreRevision((current) => current + 1);
    } else if (!didLoad && snapshot && pendingOlderLoadScrollSnapshotRef.current === snapshot) {
      pendingOlderLoadScrollSnapshotRef.current = null;
      if (!pendingNewerLoadScrollSnapshotRef.current) {
        historyScrollTransactionActiveRef.current = false;
        recordMessageGeometryEvent('history_transaction_finished', () => ({
          resetKey,
          direction: 'older',
          reason: 'load_not_committed',
          timeline: captureMessageTimelineGeometry(scrollerRef.current),
        }));
      }
    }
  }, [
    captureHistoryLoadScrollSnapshot,
    historyLoadPausedUntilRef,
    historyScrollTransactionActiveRef,
    loadOlder,
    pendingNewerLoadScrollSnapshotRef,
    pendingOlderLoadScrollSnapshotRef,
    resetKey,
    scrollerRef,
    setOlderRangeError,
  ]);

  const loadNewerPreservingViewport = useCallback(async () => {
    const snapshot = captureNewerHistoryLoadScrollSnapshot();
    const didLoad = await loadNewer();
    recordMessageGeometryEvent('history_load_resolved', () => ({
      resetKey,
      direction: 'newer',
      didLoad: Boolean(didLoad),
      snapshot: summarizeHistorySnapshot(snapshot),
      timeline: captureMessageTimelineGeometry(scrollerRef.current),
    }));
    const isHistoryPaused = historyLoadPausedUntilRef.current > Date.now();
    setNewerRangeError(didLoad === false && !isHistoryPaused);
    if (didLoad && snapshot && pendingNewerLoadScrollSnapshotRef.current === snapshot) {
      snapshot.readyToRestore = true;
      setHistoryRestoreRevision((current) => current + 1);
    } else if (!didLoad && snapshot && pendingNewerLoadScrollSnapshotRef.current === snapshot) {
      pendingNewerLoadScrollSnapshotRef.current = null;
      if (!pendingOlderLoadScrollSnapshotRef.current) {
        historyScrollTransactionActiveRef.current = false;
        recordMessageGeometryEvent('history_transaction_finished', () => ({
          resetKey,
          direction: 'newer',
          reason: 'load_not_committed',
          timeline: captureMessageTimelineGeometry(scrollerRef.current),
        }));
      }
    }
  }, [
    captureNewerHistoryLoadScrollSnapshot,
    historyLoadPausedUntilRef,
    historyScrollTransactionActiveRef,
    loadNewer,
    pendingNewerLoadScrollSnapshotRef,
    pendingOlderLoadScrollSnapshotRef,
    resetKey,
    scrollerRef,
    setNewerRangeError,
  ]);

  const restoreHistoryViewportAfterCommit = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    // Pagination state can commit before the load promise settles. Compensate
    // that commit immediately so the skeleton-to-message swap never paints
    // without its captured viewport anchor.
    let restoredHistoryViewport = false;
    const olderSnapshot = pendingOlderLoadScrollSnapshotRef.current;
    const newerSnapshot = pendingNewerLoadScrollSnapshotRef.current;
    if (olderSnapshot || newerSnapshot) {
      recordMessageGeometryEvent('history_commit_before_restore', () => ({
        resetKey,
        olderSnapshot: summarizeHistorySnapshot(olderSnapshot),
        newerSnapshot: summarizeHistorySnapshot(newerSnapshot),
        timeline: captureMessageTimelineGeometry(scroller),
      }));
    }
    viewportAnchorRestoreInProgressRef.current = Boolean(olderSnapshot || newerSnapshot);

    try {
      if (olderSnapshot) {
        const restoredOlderViewport = restoreHistoryLoadScrollSnapshot(olderSnapshot);
        restoredHistoryViewport = restoredOlderViewport || restoredHistoryViewport;
        if (olderSnapshot.readyToRestore && restoredOlderViewport) {
          pendingOlderLoadScrollSnapshotRef.current = null;
        }
      }

      if (newerSnapshot) {
        const restoredNewerViewport = restoreNewerHistoryLoadScrollSnapshot(newerSnapshot);
        restoredHistoryViewport = restoredNewerViewport || restoredHistoryViewport;
        if (newerSnapshot.readyToRestore && restoredNewerViewport) {
          pendingNewerLoadScrollSnapshotRef.current = null;
        }
      }
    } finally {
      viewportAnchorRestoreInProgressRef.current = false;
    }

    if (restoredHistoryViewport) {
      captureViewportAnchorLock(scroller);
    }

    const hasPendingHistorySnapshot = Boolean(
      pendingOlderLoadScrollSnapshotRef.current ||
      pendingNewerLoadScrollSnapshotRef.current
    );
    if (hasPendingHistorySnapshot) {
      cancelHistoryTransactionRelease();
      historyScrollTransactionActiveRef.current = true;
    } else if (restoredHistoryViewport) {
      releaseHistoryTransactionAfterScrollEvent();
    } else {
      cancelHistoryTransactionRelease();
      historyScrollTransactionActiveRef.current = false;
    }
    if (olderSnapshot || newerSnapshot) {
      recordMessageGeometryEvent('history_commit_after_restore', () => ({
        resetKey,
        restoredHistoryViewport,
        hasPendingHistorySnapshot,
        timeline: captureMessageTimelineGeometry(scroller),
      }));
    }
  }, [
    cancelHistoryTransactionRelease,
    captureViewportAnchorLock,
    historyScrollTransactionActiveRef,
    pendingNewerLoadScrollSnapshotRef,
    pendingOlderLoadScrollSnapshotRef,
    releaseHistoryTransactionAfterScrollEvent,
    resetKey,
    restoreNewerHistoryLoadScrollSnapshot,
    restoreHistoryLoadScrollSnapshot,
    scrollerRef,
    viewportAnchorRestoreInProgressRef,
  ]);

  return {
    historyRestoreRevision,
    loadOlderPreservingViewport,
    loadNewerPreservingViewport,
    restoreHistoryViewportAfterCommit,
    syncScrollState,
  };
}
