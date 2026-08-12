export const getRenderedNewerHistoryRangeLimit = ({
  historyLogicalSlotHeight,
  prefetchDistance,
}: {
  historyLogicalSlotHeight: number;
  prefetchDistance: number;
}) => Math.min(historyLogicalSlotHeight, prefetchDistance);

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
