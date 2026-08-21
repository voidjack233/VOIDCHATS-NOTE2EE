export const PRESENT_DISTANCE_PX = 16;
export const UNDERFILL_TOLERANCE_PX = 48;
export const JUMP_BUTTON_DISTANCE_PX = 180;
export const RESTORE_TOLERANCE_PX = 4;
export const HISTORY_LOAD_COOLDOWN_MS = 400;

export interface TimelineMetrics {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
}

export function distanceFromPresent(metrics: TimelineMetrics): number {
  return Math.max(
    0,
    metrics.contentHeight - metrics.viewportHeight - metrics.offsetY,
  );
}

export function isPhysicallyAtPresent(metrics: TimelineMetrics): boolean {
  return distanceFromPresent(metrics) <= PRESENT_DISTANCE_PX;
}

export function shouldShowJumpToPresent(
  metrics: TimelineMetrics,
  hasNewer: boolean,
): boolean {
  return hasNewer || distanceFromPresent(metrics) >= JUMP_BUTTON_DISTANCE_PX;
}

export function isViewportUnderfilled(metrics: TimelineMetrics): boolean {
  return (
    metrics.viewportHeight > 0 &&
    metrics.contentHeight <= metrics.viewportHeight + UNDERFILL_TOLERANCE_PX
  );
}

export function isNearHistoryStart(
  metrics: TimelineMetrics,
  viewportThreshold = 0.25,
): boolean {
  return (
    metrics.viewportHeight > 0 &&
    metrics.offsetY <= metrics.viewportHeight * viewportThreshold
  );
}

export function estimatedMessageOffset(
  index: number,
  itemCount: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  const averageHeight = itemCount > 0 ? contentHeight / itemCount : 80;
  return Math.max(0, averageHeight * index - viewportHeight / 2);
}
