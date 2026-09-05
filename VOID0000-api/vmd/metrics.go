package vmd

import "sync/atomic"

type Metrics struct {
	persistentCacheHits         atomic.Uint64
	persistentCacheMisses       atomic.Uint64
	persistentCacheCorrupt      atomic.Uint64
	persistentCacheReadFailures atomic.Uint64
	persistentCacheWriteFailure atomic.Uint64
	transformsGenerated         atomic.Uint64
	queueFull                   atomic.Uint64
	queueTimeouts               atomic.Uint64
}

func (m *Metrics) Snapshot(queue QueueSnapshot) map[string]any {
	return map[string]any{
		"persistent_cache_hits":           m.persistentCacheHits.Load(),
		"persistent_cache_misses":         m.persistentCacheMisses.Load(),
		"persistent_cache_corrupt":        m.persistentCacheCorrupt.Load(),
		"persistent_cache_read_failures":  m.persistentCacheReadFailures.Load(),
		"persistent_cache_write_failures": m.persistentCacheWriteFailure.Load(),
		"transforms_generated":            m.transformsGenerated.Load(),
		"queue_full":                      m.queueFull.Load(),
		"queue_timeouts":                  m.queueTimeouts.Load(),
		"work_queue":                      queue,
	}
}
