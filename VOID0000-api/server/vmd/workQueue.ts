import { VmdMediaError } from './imageVariants.js';

type VmdQueueJob<Result> = {
  task: () => Result | PromiseLike<Result>;
  resolve: (result: Result) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout | null;
};

export class VmdWorkQueue<Result = unknown> {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly waitTimeoutMs: number;
  active: number;
  readonly pending: VmdQueueJob<Result>[];

  constructor({
    maxConcurrent,
    maxQueued,
    waitTimeoutMs,
  }: {
    maxConcurrent: number;
    maxQueued: number;
    waitTimeoutMs: number;
  }) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new TypeError('maxConcurrent must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) {
      throw new TypeError('maxQueued must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1) {
      throw new TypeError('waitTimeoutMs must be a positive safe integer');
    }

    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.waitTimeoutMs = waitTimeoutMs;
    this.active = 0;
    this.pending = [];
  }

  run(task: () => Result | PromiseLike<Result>): Promise<Result> {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('VMD queue task must be a function'));
    }

    return new Promise<Result>((resolve, reject) => {
      const job: VmdQueueJob<Result> = { task, resolve, reject, timer: null };

      if (this.active < this.maxConcurrent) {
        this.start(job);
        return;
      }

      if (this.pending.length >= this.maxQueued) {
        reject(new VmdMediaError('VMD is temporarily at capacity', {
          code: 'VMD_AT_CAPACITY',
          status: 503,
        }));
        return;
      }

      job.timer = setTimeout(() => {
        const index = this.pending.indexOf(job);
        if (index === -1) return;
        this.pending.splice(index, 1);
        reject(new VmdMediaError('VMD queue wait timed out', {
          code: 'VMD_QUEUE_TIMEOUT',
          status: 503,
        }));
      }, this.waitTimeoutMs);
      job.timer.unref?.();
      this.pending.push(job);
    });
  }

  start(job: VmdQueueJob<Result>): void {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }

    this.active += 1;
    void Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => this.finish());
  }

  finish(): void {
    this.active -= 1;
    const next = this.pending.shift();
    if (next) {
      this.start(next);
    }
  }

  getSnapshot(): {
    active: number;
    queued: number;
    maxConcurrent: number;
    maxQueued: number;
  } {
    return {
      active: this.active,
      queued: this.pending.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    };
  }
}
