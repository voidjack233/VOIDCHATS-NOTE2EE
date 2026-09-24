import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';

export const HISTORY_STAGES = [
  'total', 'auth', 'fetch_limit', 'conversation', 'storage_resolution', 'membership',
  'history_wait', 'scylla_messages', 'reactions_total', 'reaction_counts', 'user_reactions', 'reaction_mapping',
  'attachments_pg', 'attachment_policy', 'legacy_stat', 'original_signing',
  'vmd_signing', 'attachment_delivery', 'message_mapping', 'descriptor_parsing', 'descriptor_mapping', 'serialization',
] as const;
type Stage = typeof HISTORY_STAGES[number];
const BOUNDS_MS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 5000];

// Fixed cardinality and constant space: never retain request objects, identifiers or samples.
export class HistoryMetrics {
  private readonly context = new AsyncLocalStorage<boolean>();
  private readonly timers = Object.fromEntries(HISTORY_STAGES.map(stage => [stage, {
    count: 0, errors: 0, sumMs: 0, maxMs: 0, buckets: Array<number>(BOUNDS_MS.length + 1).fill(0),
  }])) as Record<Stage, { count: number; errors: number; sumMs: number; maxMs: number; buckets: number[] }>;

  private start(stage: Stage) {
    if (!this.context.getStore()) return () => {};
    const started = performance.now();
    let finished = false;
    return (failed = false) => {
      if (finished) return;
      finished = true;
      const ms = performance.now() - started;
      const timer = this.timers[stage];
      timer.count++;
      timer.errors += Number(failed);
      timer.sumMs += ms;
      timer.maxMs = Math.max(timer.maxMs, ms);
      const bucket = BOUNDS_MS.findIndex(bound => ms <= bound);
      timer.buckets[bucket < 0 ? BOUNDS_MS.length : bucket]++;
    };
  }

  async time<T>(stage: Stage, task: () => Promise<T>): Promise<T> {
    const stop = this.start(stage);
    try { const value = await task(); stop(); return value; }
    catch (error) { stop(true); throw error; }
  }

  sync<T>(stage: Stage, task: () => T): T {
    const stop = this.start(stage);
    try { return task(); }
    catch (error) { stop(true); throw error; }
    finally { stop(); }
  }

  middleware(stage: 'auth' | 'fetch_limit', handler: RequestHandler): RequestHandler {
    return (req, res, next) => {
      if (!this.context.getStore()) return handler(req, res, next);
      const stop = this.start(stage);
      const finish = () => { stop(res.statusCode >= 400 || !res.writableFinished); cleanup(); };
      const cleanup = () => { res.off('finish', finish); res.off('close', finish); };
      res.once('finish', finish); res.once('close', finish);
      try {
        const result = handler(req, res, error => { stop(Boolean(error)); cleanup(); next(error); });
        return Promise.resolve(result).catch(error => { stop(true); cleanup(); throw error; });
      } catch (error) { stop(true); cleanup(); throw error; }
    };
  }

  // Installed at the messages mount, before authentication. Other message routes are excluded.
  request: RequestHandler = (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || req.path !== '/') return next();
    this.context.run(true, () => {
      const stop = this.start('total');
      const finish = () => {
        stop(res.statusCode >= 400 || !res.writableFinished);
        res.off('finish', finish); res.off('close', finish);
      };
      res.once('finish', finish); res.once('close', finish);
      const json = res.json;
      res.json = body => this.sync('serialization', () => json.call(res, body));
      next();
    });
  };

  getSnapshot() {
    return {
      boundsMs: [...BOUNDS_MS, null], // Non-cumulative buckets; null is the overflow bucket.
      stages: Object.fromEntries(HISTORY_STAGES.map(stage => [stage, {
        ...this.timers[stage], buckets: [...this.timers[stage].buckets],
      }])),
    };
  }
}

export const historyMetrics = new HistoryMetrics();
