import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import {
  captureMessageTimelineGeometry,
  isMessageGeometryDiagnosticsEnabled,
  recordMessageGeometryEvent,
} from './messageGeometryDiagnostics';
import { resolveHistoryLogicalRangeGeometry } from './messageHistoryRangeGeometry';

export type HistoryRangeStatus = 'idle' | 'loading' | 'loaded' | 'error';

interface ScrollGeometryInput {
  scrollerRef?: { current: HTMLElement | null };
  scrollCompensationBlockerRef?: { current: unknown };
  resetKey?: string;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  hasOlder: boolean;
  hasNewer: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  olderRangeError: boolean;
  newerRangeError: boolean;
  historyLogicalSlotHeight: number;
  bottomThreshold: number;
  jumpToPresentRevealDistance: number;
  enablePhysicalSpacerWindowing?: boolean;
  maxPhysicalSpacerHeight?: number;
  maxPhysicalBottomSpacerHeight?: number;
}

interface ScrollState {
  distanceFromBottom: number;
  atBottom: boolean;
  shouldShowJumpToPresent: boolean;
  isAtPresent: boolean;
}

export const getTopSpacerScrollCompensation = ({
  previousHeight,
  nextHeight,
  blocked,
}: {
  previousHeight: number | null;
  nextHeight: number;
  blocked: boolean;
}) => {
  if (previousHeight === null || blocked) return 0;
  const delta = nextHeight - previousHeight;
  return Math.abs(delta) > 0.5 ? delta : 0;
};

export const useMessageScrollGeometry = ({
  scrollerRef,
  scrollCompensationBlockerRef,
  resetKey,
  topSpacerHeight,
  bottomSpacerHeight,
  hasOlder,
  hasNewer,
  loadingOlder,
  loadingNewer,
  olderRangeError,
  newerRangeError,
  historyLogicalSlotHeight,
  bottomThreshold,
  jumpToPresentRevealDistance,
  enablePhysicalSpacerWindowing = false,
  maxPhysicalSpacerHeight = Number.POSITIVE_INFINITY,
  maxPhysicalBottomSpacerHeight,
}: ScrollGeometryInput) => {
  const {
    topTrimmedSpacerHeight,
    bottomTrimmedSpacerHeight,
    topEstimatedLoadingHeight,
    bottomEstimatedLoadingHeight,
    topLogicalRangeHeight,
    bottomLogicalRangeHeight,
  } = resolveHistoryLogicalRangeGeometry({
    topSpacerHeight,
    bottomSpacerHeight,
    hasOlder,
    hasNewer,
    historyLogicalSlotHeight,
  });

  const physicalTopSpacerLimit = enablePhysicalSpacerWindowing && Number.isFinite(maxPhysicalSpacerHeight)
    ? Math.max(0, maxPhysicalSpacerHeight)
    : Number.POSITIVE_INFINITY;
  const bottomSpacerLimitSource = maxPhysicalBottomSpacerHeight ?? maxPhysicalSpacerHeight;
  const physicalBottomSpacerLimit = enablePhysicalSpacerWindowing && Number.isFinite(bottomSpacerLimitSource)
    ? Math.max(0, bottomSpacerLimitSource)
    : Number.POSITIVE_INFINITY;

  // Logical spacers remain the source of truth. Rendered spacers can be capped
  // so the browser does not carry a giant physical scroll layer forever.
  const renderedTopSpacerHeight = Math.min(topLogicalRangeHeight, physicalTopSpacerLimit);
  const renderedBottomSpacerHeight = Math.min(bottomLogicalRangeHeight, physicalBottomSpacerLimit);
  const topOriginOffset = Math.max(0, topLogicalRangeHeight - renderedTopSpacerHeight);
  const bottomOriginOffset = Math.max(0, bottomLogicalRangeHeight - renderedBottomSpacerHeight);
  const isPhysicalSpacerCompacted = topOriginOffset > 0 || bottomOriginOffset > 0;

  const previousResetKeyRef = useRef(resetKey);
  const previousRenderedTopSpacerHeightRef = useRef<number | null>(null);
  const previousGeometryRef = useRef<{
    topLogicalRangeHeight: number;
    bottomLogicalRangeHeight: number;
    renderedTopSpacerHeight: number;
    renderedBottomSpacerHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    const previous = previousGeometryRef.current;
    const next = {
      topLogicalRangeHeight,
      bottomLogicalRangeHeight,
      renderedTopSpacerHeight,
      renderedBottomSpacerHeight,
    };
    previousGeometryRef.current = next;

    if (previousResetKeyRef.current !== resetKey) {
      previousGeometryRef.current = next;
      return;
    }

    const changed = !previous || Object.keys(next).some((key) => (
      Math.abs(next[key as keyof typeof next] - previous[key as keyof typeof previous]) > 0.5
    ));
    if (!changed) return;

    recordMessageGeometryEvent(previous ? 'history_spacer_geometry_commit' : 'history_spacer_geometry_initial', () => ({
      resetKey,
      previous,
      next,
      loadingOlder,
      loadingNewer,
      hasOlder,
      hasNewer,
      compensationBlocked: Boolean(scrollCompensationBlockerRef?.current),
      timeline: captureMessageTimelineGeometry(scrollerRef?.current || null),
    }));
  }, [
    bottomLogicalRangeHeight,
    hasNewer,
    hasOlder,
    loadingNewer,
    loadingOlder,
    renderedBottomSpacerHeight,
    renderedTopSpacerHeight,
    resetKey,
    scrollerRef,
    scrollCompensationBlockerRef,
    topLogicalRangeHeight,
  ]);

  useLayoutEffect(() => {
    if (previousResetKeyRef.current !== resetKey) {
      previousResetKeyRef.current = resetKey;
      previousRenderedTopSpacerHeightRef.current = renderedTopSpacerHeight;
      return;
    }

    const previousRenderedTopSpacerHeight = previousRenderedTopSpacerHeightRef.current;
    previousRenderedTopSpacerHeightRef.current = renderedTopSpacerHeight;

    if (!enablePhysicalSpacerWindowing) {
      return;
    }

    const topSpacerDelta = getTopSpacerScrollCompensation({
      previousHeight: previousRenderedTopSpacerHeight,
      nextHeight: renderedTopSpacerHeight,
      blocked: Boolean(scrollCompensationBlockerRef?.current),
    });
    if (topSpacerDelta === 0) {
      return;
    }

    const scroller = scrollerRef?.current;
    if (!scroller) {
      return;
    }

    const before = isMessageGeometryDiagnosticsEnabled()
      ? captureMessageTimelineGeometry(scroller, {
          topSpacerDelta,
          previousRenderedTopSpacerHeight,
          renderedTopSpacerHeight,
        })
      : null;
    scroller.scrollTo({
      top: Math.max(0, scroller.scrollTop + topSpacerDelta),
    });
    recordMessageGeometryEvent('history_top_spacer_scroll_compensation', () => ({
      before,
      after: captureMessageTimelineGeometry(scroller, {
        topSpacerDelta,
        previousRenderedTopSpacerHeight,
        renderedTopSpacerHeight,
      }),
    }));
  }, [
    enablePhysicalSpacerWindowing,
    renderedTopSpacerHeight,
    resetKey,
    scrollerRef,
    scrollCompensationBlockerRef,
  ]);

  const olderRangeStatus: HistoryRangeStatus = loadingOlder
    ? 'loading'
    : olderRangeError
      ? 'error'
      : topLogicalRangeHeight <= 1
        ? 'loaded'
        : hasOlder
          ? 'idle'
          : 'error';

  const newerRangeStatus: HistoryRangeStatus = loadingNewer
    ? 'loading'
    : newerRangeError
      ? 'error'
      : bottomLogicalRangeHeight <= 1
        ? 'loaded'
        : hasNewer
          ? 'idle'
          : 'error';

  const getScrollState = useCallback((scroller: HTMLElement): ScrollState => {
    const distanceFromBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    const atBottom = distanceFromBottom <= bottomThreshold && !hasNewer && bottomLogicalRangeHeight <= 1;
    const shouldShowJumpToPresent = !atBottom && (
      hasNewer ||
      bottomLogicalRangeHeight > 1 ||
      distanceFromBottom >= jumpToPresentRevealDistance
    );

    return {
      distanceFromBottom,
      atBottom,
      shouldShowJumpToPresent,
      isAtPresent: atBottom && !hasNewer,
    };
  }, [bottomLogicalRangeHeight, bottomThreshold, hasNewer, jumpToPresentRevealDistance]);

  const getOlderBoundaryDistance = useCallback((scroller: HTMLElement) => (
    scroller.scrollTop - Math.max(0, renderedTopSpacerHeight)
  ), [renderedTopSpacerHeight]);

  const getNewerBoundaryDistance = useCallback((scroller: HTMLElement) => (
    scroller.scrollHeight -
    Math.max(0, renderedBottomSpacerHeight) -
    (scroller.scrollTop + scroller.clientHeight)
  ), [renderedBottomSpacerHeight]);

  const isOlderRangeVisible = useCallback((scroller: HTMLElement) => {
    if (renderedTopSpacerHeight <= 1) {
      return false;
    }

    return scroller.scrollTop < renderedTopSpacerHeight &&
      scroller.scrollTop + scroller.clientHeight > 0;
  }, [renderedTopSpacerHeight]);

  const isNewerRangeVisible = useCallback((scroller: HTMLElement) => {
    if (renderedBottomSpacerHeight <= 1) {
      return false;
    }

    const bottomRangeStart = scroller.scrollHeight - renderedBottomSpacerHeight;
    return scroller.scrollTop + scroller.clientHeight >= bottomRangeStart &&
      scroller.scrollTop <= scroller.scrollHeight;
  }, [renderedBottomSpacerHeight]);

  const getLoadedScrollHeight = useCallback((scroller: HTMLElement) => (
    Math.max(0, scroller.scrollHeight - (renderedTopSpacerHeight + renderedBottomSpacerHeight))
  ), [renderedBottomSpacerHeight, renderedTopSpacerHeight]);

  return useMemo(() => ({
    topTrimmedSpacerHeight,
    bottomTrimmedSpacerHeight,
    topEstimatedLoadingHeight,
    bottomEstimatedLoadingHeight,
    topLogicalRangeHeight,
    bottomLogicalRangeHeight,
    renderedTopSpacerHeight,
    renderedBottomSpacerHeight,
    topOriginOffset,
    bottomOriginOffset,
    isPhysicalSpacerCompacted,
    olderRangeStatus,
    newerRangeStatus,
    getScrollState,
    getOlderBoundaryDistance,
    getNewerBoundaryDistance,
    isOlderRangeVisible,
    isNewerRangeVisible,
    getLoadedScrollHeight,
  }), [
    bottomEstimatedLoadingHeight,
    bottomLogicalRangeHeight,
    bottomTrimmedSpacerHeight,
    getLoadedScrollHeight,
    getNewerBoundaryDistance,
    getOlderBoundaryDistance,
    getScrollState,
    isNewerRangeVisible,
    isOlderRangeVisible,
    newerRangeStatus,
    olderRangeStatus,
    bottomOriginOffset,
    renderedBottomSpacerHeight,
    renderedTopSpacerHeight,
    isPhysicalSpacerCompacted,
    topOriginOffset,
    topEstimatedLoadingHeight,
    topLogicalRangeHeight,
    topTrimmedSpacerHeight,
  ]);
};
