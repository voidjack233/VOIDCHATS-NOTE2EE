export const MAX_RENDERED_NEWER_RANGE_HEIGHT = 72;

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

export const shouldShowNewerHistoryLoader = ({
  loadingNewer,
  visibleMessageCount,
}: {
  loadingNewer: boolean;
  visibleMessageCount: number;
}) => loadingNewer && visibleMessageCount > 0;
