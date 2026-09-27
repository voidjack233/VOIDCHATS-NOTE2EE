export function valkeyRetryDelay(times: number): number {
  return Math.min(times * 200, 2000);
}
