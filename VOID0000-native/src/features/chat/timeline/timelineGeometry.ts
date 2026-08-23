export const PRESENT_DISTANCE_PX = 16;
export const JUMP_BUTTON_DISTANCE_PX = 180;

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
