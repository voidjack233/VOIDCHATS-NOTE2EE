package vmd

import (
	"context"
	"sync"
	"time"
)

type queuedResult[T any] struct {
	value T
	err   error
}

type queueJob[T any] struct {
	task     func() (T, error)
	result   chan queuedResult[T]
	timer    *time.Timer
	finished bool
}

type QueueSnapshot struct {
	Active        int `json:"active"`
	Queued        int `json:"queued"`
	MaxConcurrent int `json:"maxConcurrent"`
	MaxQueued     int `json:"maxQueued"`
}

type WorkQueue[T any] struct {
	mu            sync.Mutex
	maxConcurrent int
	maxQueued     int
	waitTimeout   time.Duration
	active        int
	pending       []*queueJob[T]
	closed        bool
}

func NewWorkQueue[T any](maxConcurrent, maxQueued int, waitTimeout time.Duration) *WorkQueue[T] {
	return &WorkQueue[T]{
		maxConcurrent: maxConcurrent,
		maxQueued:     maxQueued,
		waitTimeout:   waitTimeout,
	}
}

func (q *WorkQueue[T]) Run(ctx context.Context, task func() (T, error)) (T, error) {
	var zero T
	if task == nil {
		return zero, mediaError(500, "VMD_DELIVERY_FAILED", "VMD queue task is invalid", nil)
	}

	job := &queueJob[T]{
		task:   task,
		result: make(chan queuedResult[T], 1),
	}

	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return zero, mediaError(503, "VMD_AT_CAPACITY", "VMD is shutting down", nil)
	}
	if q.active < q.maxConcurrent {
		q.active++
		q.mu.Unlock()
		q.start(job)
	} else {
		if len(q.pending) >= q.maxQueued {
			q.mu.Unlock()
			return zero, mediaError(503, "VMD_AT_CAPACITY", "VMD is temporarily at capacity", nil)
		}
		q.pending = append(q.pending, job)
		job.timer = time.AfterFunc(q.waitTimeout, func() {
			q.timeout(job)
		})
		q.mu.Unlock()
	}

	select {
	case result := <-job.result:
		return result.value, result.err
	case <-ctx.Done():
		return zero, ctx.Err()
	}
}

func (q *WorkQueue[T]) timeout(job *queueJob[T]) {
	q.mu.Lock()
	if job.finished {
		q.mu.Unlock()
		return
	}
	for index, pending := range q.pending {
		if pending != job {
			continue
		}
		q.pending = append(q.pending[:index], q.pending[index+1:]...)
		job.finished = true
		q.mu.Unlock()
		var zero T
		job.result <- queuedResult[T]{
			value: zero,
			err:   mediaError(503, "VMD_QUEUE_TIMEOUT", "VMD queue wait timed out", nil),
		}
		return
	}
	q.mu.Unlock()
}

func (q *WorkQueue[T]) start(job *queueJob[T]) {
	if job.timer != nil {
		job.timer.Stop()
	}
	go func() {
		value, err := job.task()
		job.result <- queuedResult[T]{value: value, err: err}
		q.finish(job)
	}()
}

func (q *WorkQueue[T]) finish(job *queueJob[T]) {
	q.mu.Lock()
	job.finished = true
	q.active--
	if len(q.pending) == 0 || q.closed {
		q.mu.Unlock()
		return
	}
	next := q.pending[0]
	q.pending = q.pending[1:]
	q.active++
	q.mu.Unlock()
	q.start(next)
}

func (q *WorkQueue[T]) Snapshot() QueueSnapshot {
	q.mu.Lock()
	defer q.mu.Unlock()
	return QueueSnapshot{
		Active:        q.active,
		Queued:        len(q.pending),
		MaxConcurrent: q.maxConcurrent,
		MaxQueued:     q.maxQueued,
	}
}

func (q *WorkQueue[T]) Close() {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return
	}
	q.closed = true
	pending := q.pending
	q.pending = nil
	q.mu.Unlock()

	for _, job := range pending {
		if job.timer != nil {
			job.timer.Stop()
		}
		var zero T
		job.result <- queuedResult[T]{
			value: zero,
			err:   mediaError(503, "VMD_AT_CAPACITY", "VMD is shutting down", nil),
		}
	}
}
