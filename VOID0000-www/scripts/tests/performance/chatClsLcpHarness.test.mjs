import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateScenarioResults,
  calculateCls,
  countImageAttachments,
  normalizeConversationRoute,
  parsePositiveInteger,
  summarizeValues,
} from '../../performance/chat-cls-lcp-core.mjs';

test('attachment classifier parses serialized API descriptors', () => {
  assert.equal(countImageAttachments([
    JSON.stringify({ url: 'https://cdn.example/image', mime: 'image/jpeg' }),
    { url: 'https://cdn.example/file', mime: 'application/pdf' },
    'https://cdn.example/legacy',
  ]), 1);
});

test('CLS uses the largest five-second session window', () => {
  assert.equal(calculateCls([
    { startTime: 100, value: 0.04, hadRecentInput: false },
    { startTime: 700, value: 0.03, hadRecentInput: false },
    { startTime: 2_000, value: 0.2, hadRecentInput: false },
    { startTime: 2_200, value: 1, hadRecentInput: true },
  ]), 0.2);
});

test('summaries expose median and worst values', () => {
  assert.deepEqual(summarizeValues([4, 1, 3, 2, 5]), {
    count: 5,
    minimum: 1,
    median: 3,
    p95: 5,
    maximum: 5,
  });
});

test('scenario aggregation keeps viewport and scenario independent', () => {
  const [summary] = aggregateScenarioResults([
    { viewport: 'desktop', scenario: 'history', cls: 0.02, lcp: { durationMs: 100 }, anchor: { offsetDeltaPx: 1 } },
    { viewport: 'desktop', scenario: 'history', cls: 0.04, lcp: { durationMs: 200 }, anchor: { offsetDeltaPx: 2 } },
  ]);
  assert.equal(summary.cls.median, 0.03);
  assert.equal(summary.cls.maximum, 0.04);
  assert.equal(summary.lcpMs.median, 150);
  assert.equal(summary.lcpMs.maximum, 200);
});

test('numeric and route configuration rejects unsafe values', () => {
  assert.equal(parsePositiveInteger('5', 3, 'RUNS'), 5);
  assert.throws(() => parsePositiveInteger('0', 3, 'RUNS'), /positive integer/);
  assert.equal(
    normalizeConversationRoute('/chats/@me/123', 'https://void0000.online'),
    '/chats/@me/123',
  );
  assert.throws(
    () => normalizeConversationRoute('https://example.com/chats/123', 'https://void0000.online'),
    /frontend origin/,
  );
});
