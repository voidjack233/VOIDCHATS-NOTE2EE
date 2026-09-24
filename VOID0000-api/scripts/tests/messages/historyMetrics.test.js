import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { HistoryMetrics, HISTORY_STAGES } from '../../../server/health/historyMetrics.js';

test('history timers preserve results/errors, isolate non-history work, and keep bounded snapshots', async t => {
  const metrics = new HistoryMetrics();
  await metrics.time('conversation', async () => 'outside');
  const app = express();
  app.use('/messages', metrics.request, metrics.middleware('auth', (req, res, next) => {
    if (req.query.deny) return res.status(401).json({ error: 'denied' });
    next();
  }));
  app.get('/messages', metrics.middleware('fetch_limit', (_req, _res, next) => next()), async (_req, res) => {
    assert.equal(await metrics.time('membership', async () => true), true);
    assert.equal(metrics.sync('message_mapping', () => 42), 42);
    const error = new Error('private identifier must never be recorded');
    await assert.rejects(metrics.time('scylla_messages', async () => { throw error; }), e => e === error);
    assert.throws(() => metrics.sync('attachment_policy', () => { throw error; }), e => e === error);
    res.json({ success: true });
  });
  app.get('/messages/other', (_req, res) => res.json({ success: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/messages`;
  for (const path of ['', '?deny=1', '/other']) await (await fetch(base + path)).json();
  const snapshot = metrics.getSnapshot();
  assert.deepEqual(Object.keys(snapshot.stages), [...HISTORY_STAGES]);
  assert.equal(snapshot.stages.total.count, 2);
  assert.equal(snapshot.stages.total.errors, 1);
  assert.equal(snapshot.stages.auth.count, 2);
  assert.equal(snapshot.stages.auth.errors, 1);
  assert.equal(snapshot.stages.fetch_limit.count, 1);
  assert.equal(snapshot.stages.membership.count, 1);
  assert.equal(snapshot.stages.conversation.count, 0);
  assert.equal(snapshot.stages.scylla_messages.errors, 1);
  assert.equal(snapshot.stages.attachment_policy.errors, 1);
  for (const timer of Object.values(snapshot.stages)) {
    assert.equal(timer.buckets.length, snapshot.boundsMs.length);
    assert.equal(timer.buckets.reduce((a, b) => a + b, 0), timer.count);
  }
  assert.doesNotMatch(JSON.stringify(snapshot), /private identifier|success|denied|https?:/);
  snapshot.stages.total.buckets[0] = -1;
  assert.ok(metrics.getSnapshot().stages.total.buckets[0] >= 0);
});
