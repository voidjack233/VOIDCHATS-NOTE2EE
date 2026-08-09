package vmd

import (
	"context"
	"sync"
)

type flightResult[T any] struct {
	value T
	err   error
}

type flight[T any] struct {
	done   chan struct{}
	result flightResult[T]
}

type FlightGroup[T any] struct {
	mu        sync.Mutex
	maxActive int
	active    map[string]*flight[T]
}

func NewFlightGroup[T any](maxActive int) *FlightGroup[T] {
	return &FlightGroup[T]{
		maxActive: maxActive,
		active:    make(map[string]*flight[T]),
	}
}

func (g *FlightGroup[T]) Do(ctx context.Context, key string, task func() (T, error)) (T, error) {
	g.mu.Lock()
	if current := g.active[key]; current != nil {
		g.mu.Unlock()
		select {
		case <-current.done:
			return current.result.value, current.result.err
		case <-ctx.Done():
			var zero T
			return zero, ctx.Err()
		}
	}
	if g.maxActive == 0 || len(g.active) >= g.maxActive {
		g.mu.Unlock()
		return task()
	}

	current := &flight[T]{done: make(chan struct{})}
	g.active[key] = current
	g.mu.Unlock()

	current.result.value, current.result.err = task()
	close(current.done)

	g.mu.Lock()
	if g.active[key] == current {
		delete(g.active, key)
	}
	g.mu.Unlock()
	return current.result.value, current.result.err
}
