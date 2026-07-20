const counters = {
  persistent_cache_hits: 0,
  persistent_cache_misses: 0,
  persistent_cache_corrupt: 0,
  persistent_cache_read_failures: 0,
  persistent_cache_write_failures: 0,
  transforms_generated: 0,
  queue_full: 0,
  queue_timeouts: 0,
};

export function incrementVmdMetric(name) {
  if (!Object.hasOwn(counters, name)) {
    throw new TypeError(`Unknown VMD metric: ${name}`);
  }
  counters[name] += 1;
}

export function getVmdMetricsSnapshot() {
  return { ...counters };
}
