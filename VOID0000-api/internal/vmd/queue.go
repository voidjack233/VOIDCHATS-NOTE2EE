package vmd

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"
)

type queuedResult[T any] struct {
	value T
	err   error
}

type queueJobState uint8

const (
	queueJobCreated queueJobState = iota
	queueJobPending
	queueJobActive
	queueJobFinished
)

type queueJob[T any] struct {
	task   func() (T, error)
	result chan queuedResult[T]
	timer  *time.Timer
	state  queueJobState
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
	drained       chan struct{}
	drainedClosed bool
	logger        *slog.Logger
}

func NewWorkQueue[T any](maxConcurrent, maxQueued int, waitTimeout time.Duration, loggers ...*slog.Logger) *WorkQueue[T] {
	logger := slog.Default()
	if len(loggers) > 0 && loggers[0] != nil {
		logger = loggers[0]
	}
	return &WorkQueue[T]{
		maxConcurrent: maxConcurrent,
		maxQueued:     maxQueued,
		waitTimeout:   waitTimeout,
		drained:       make(chan struct{}),
		logger:        logger,
	}
}

func (q *WorkQueue[T]) Run(ctx context.Context, task func() (T, error)) (T, error) {
	var zero T
	if task == nil {
		return zero, mediaError(500, "VMD_DELIVERY_FAILED", "VMD queue task is invalid", nil)
	}
	if err := ctx.Err(); err != nil {
		return zero, err
	}

	job := &queueJob[T]{
		task:   task,
		result: make(chan queuedResult[T], 1),
		state:  queueJobCreated,
	}

	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return zero, mediaError(503, "VMD_AT_CAPACITY", "VMD is shutting down", nil)
	}
	if q.active < q.maxConcurrent {
		job.state = queueJobActive
		q.active++
		q.mu.Unlock()
		q.start(job)
	} else {
		if len(q.pending) >= q.maxQueued {
			q.mu.Unlock()
			return zero, mediaError(503, "VMD_AT_CAPACITY", "VMD is temporarily at capacity", nil)
		}
		job.state = queueJobPending
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
		if q.cancelPending(job) {
			return zero, ctx.Err()
		}
		select {
		case result := <-job.result:
			return result.value, result.err
		default:
			return zero, ctx.Err()
		}
	}
}

func (q *WorkQueue[T]) removePendingLocked(job *queueJob[T]) bool {
	if job.state != queueJobPending {
		return false
	}
	for index, pending := range q.pending {
		if pending != job {
			continue
		}
		copy(q.pending[index:], q.pending[index+1:])
		q.pending[len(q.pending)-1] = nil
		q.pending = q.pending[:len(q.pending)-1]
		job.state = queueJobFinished
		if job.timer != nil {
			job.timer.Stop()
			job.timer = nil
		}
		return true
	}
	return false
}

func (q *WorkQueue[T]) cancelPending(job *queueJob[T]) bool {
	q.mu.Lock()
	removed := q.removePendingLocked(job)
	q.mu.Unlock()
	return removed
}

func (q *WorkQueue[T]) timeout(job *queueJob[T]) {
	q.mu.Lock()
	removed := q.removePendingLocked(job)
	q.mu.Unlock()
	if !removed {
		return
	}
	var zero T
	job.result <- queuedResult[T]{
		value: zero,
		err:   mediaError(503, "VMD_QUEUE_TIMEOUT", "VMD queue wait timed out", nil),
	}
}

func (q *WorkQueue[T]) start(job *queueJob[T]) {
	go func() {
		result := queuedResult[T]{}
		defer func() {
			if panicValue := recover(); panicValue != nil {
				q.logger.Error(
					"VMD work queue task panicked",
					"panic", fmt.Sprint(panicValue),
					"stack", string(debug.Stack()),
				)
				var zero T
				result = queuedResult[T]{
					value: zero,
					err: mediaError(
						500,
						"VMD_DELIVERY_FAILED",
						"VMD image delivery failed",
						nil,
					),
				}
			}
			q.finish(job)
			job.result <- result
		}()
		result.value, result.err = job.task()
	}()
}

func (q *WorkQueue[T]) finish(job *queueJob[T]) {
	var next *queueJob[T]
	q.mu.Lock()
	if job.state != queueJobActive {
		q.mu.Unlock()
		return
	}
	job.state = queueJobFinished
	q.active--
	if !q.closed && len(q.pending) > 0 {
		next = q.pending[0]
		q.pending[0] = nil
		q.pending = q.pending[1:]
		next.state = queueJobActive
		if next.timer != nil {
			next.timer.Stop()
			next.timer = nil
		}
		q.active++
	}
	q.closeDrainedLocked()
	q.mu.Unlock()
	if next != nil {
		q.start(next)
	}
}

func (q *WorkQueue[T]) closeDrainedLocked() {
	if q.closed && q.active == 0 && !q.drainedClosed {
		q.drainedClosed = true
		close(q.drained)
	}
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

func (q *WorkQueue[T]) Shutdown(ctx context.Context) error {
	var pending []*queueJob[T]
	q.mu.Lock()
	if !q.closed {
		q.closed = true
		pending = q.pending
		q.pending = nil
		for _, job := range pending {
			if job.state != queueJobPending {
				continue
			}
			job.state = queueJobFinished
			if job.timer != nil {
				job.timer.Stop()
				job.timer = nil
			}
		}
		q.closeDrainedLocked()
	}
	drained := q.drained
	q.mu.Unlock()

	for _, job := range pending {
		var zero T
		job.result <- queuedResult[T]{
			value: zero,
			err:   mediaError(503, "VMD_AT_CAPACITY", "VMD is shutting down", nil),
		}
	}

	select {
	case <-drained:
		return nil
	default:
	}
	select {
	case <-drained:
		return nil
	case <-ctx.Done():
		select {
		case <-drained:
			return nil
		default:
			return ctx.Err()
		}
	}
}
