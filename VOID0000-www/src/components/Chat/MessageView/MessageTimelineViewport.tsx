import type { ReactNode, RefObject, UIEventHandler } from 'react';
import type { Density } from '../../../Services/hooks/Settings/useTheme';
import type { HistoryRangeStatus } from './useMessageScrollGeometry';
import HistorySkeleton from './HistorySkeleton';

interface MessageTimelineViewportProps {
  setScrollerRef: (element: HTMLDivElement | null) => void;
  onScroll: UIEventHandler<HTMLDivElement>;
  initialRestoreDone: boolean;
  topLogicalRangeHeight: number;
  renderedTopSpacerHeight: number;
  topHistorySkeletonRowCount: number;
  olderRangeStatus: HistoryRangeStatus;
  hasOlder: boolean;
  olderSentinelRef: RefObject<HTMLDivElement | null>;
  showHeader: boolean;
  header: ReactNode;
  children: ReactNode;
  bottomLogicalRangeHeight: number;
  renderedBottomSpacerHeight: number;
  bottomHistorySkeletonRowCount: number;
  newerRangeStatus: HistoryRangeStatus;
  hasNewer: boolean;
  loadingNewer: boolean;
  newerSentinelRef: RefObject<HTMLDivElement | null>;
  density: Density;
}

export default function MessageTimelineViewport({
  setScrollerRef,
  onScroll,
  initialRestoreDone,
  topLogicalRangeHeight,
  renderedTopSpacerHeight,
  topHistorySkeletonRowCount,
  olderRangeStatus,
  hasOlder,
  olderSentinelRef,
  showHeader,
  header,
  children,
  bottomLogicalRangeHeight,
  renderedBottomSpacerHeight,
  bottomHistorySkeletonRowCount,
  newerRangeStatus,
  hasNewer,
  loadingNewer,
  newerSentinelRef,
  density,
}: MessageTimelineViewportProps) {
  return (
    <div
      ref={setScrollerRef}
      onScroll={onScroll}
      data-message-timeline
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
      style={{ overflowAnchor: 'none', opacity: initialRestoreDone ? 1 : 0 }}
    >
      {/* Older logical range: lets fast scroll enter unloaded history while the real batch is fetched. */}
      {topLogicalRangeHeight > 1 && (
        <div
          data-message-older-range
          className="relative flex w-full items-start justify-center"
          style={{ height: `${renderedTopSpacerHeight}px` }}
        >
          <div data-message-older-skeleton className="absolute inset-0 w-full">
            <HistorySkeleton
              density={density}
              rowCount={topHistorySkeletonRowCount}
              active={olderRangeStatus === 'loading'}
              anchorEdge="end"
            />
          </div>
          {hasOlder && <div ref={olderSentinelRef} className="absolute inset-x-0 bottom-0 h-px w-full" />}
        </div>
      )}

      {showHeader ? header : null}

      {children}

      {/* Newer logical range mirrors the older history rows at the opposite edge. */}
      {bottomLogicalRangeHeight > 1 && (hasNewer || loadingNewer) && (
        <div
          data-message-newer-range
          className="relative flex w-full items-start justify-center"
          style={{ height: `${renderedBottomSpacerHeight}px` }}
        >
          {hasNewer && <div ref={newerSentinelRef} className="absolute inset-x-0 top-0 h-px w-full" />}
          <div data-message-newer-skeleton className="absolute inset-0 w-full">
            <HistorySkeleton
              density={density}
              rowCount={bottomHistorySkeletonRowCount}
              active={newerRangeStatus === 'loading'}
              anchorEdge="start"
            />
          </div>
        </div>
      )}
    </div>
  );
}
