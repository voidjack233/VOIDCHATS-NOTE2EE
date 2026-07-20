import { VmdMediaError } from './imageVariants.js';

export class VmdWorkQueue {
  constructor({ maxConcurrent, maxQueued, waitTimeoutMs }) {
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

  run(task) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('VMD queue task must be a function'));
    }

    return new Promise((resolve, reject) => {
      const job = { task, resolve, reject, timer: null };

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

  start(job) {
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

  finish() {
    this.active -= 1;
    const next = this.pending.shift();
    if (next) {
      this.start(next);
    }
  }

  getSnapshot() {
    return {
      active: this.active,
      queued: this.pending.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    };
  }
}
