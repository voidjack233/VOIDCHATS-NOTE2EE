export const getRenderedNewerHistoryRangeLimit = ({
  historyLogicalSlotHeight,
  prefetchDistance,
}: {
  historyLogicalSlotHeight: number;
  prefetchDistance: number;
}) => Math.min(historyLogicalSlotHeight, prefetchDistance);

export const getHistoryLogicalSlotHeight = ({
  pageSize,
  skeletonRowHeight,
}: {
  pageSize: number;
  skeletonRowHeight: number;
}) => Math.max(0, pageSize) * Math.max(0, skeletonRowHeight);

interface InitialSkeletonState {
  loading: boolean;
  initialHydrationSettled: boolean;
  visibleMessageCount: number;
}

export const shouldShowInitialMessageTimelineSkeleton = ({
  loading,
  initialHydrationSettled,
  visibleMessageCount,
}: InitialSkeletonState) => (
  loading &&
  !initialHydrationSettled &&
  visibleMessageCount === 0
);
