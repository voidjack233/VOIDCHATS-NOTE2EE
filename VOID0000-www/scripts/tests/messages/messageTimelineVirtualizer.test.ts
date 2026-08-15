import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getEffectiveHistoryLoadThreshold,
  selectPreferredHistoryScrollSignal,
} from '../../../src/components/Chat/MessageView/useMessageTimelineVirtualizer';

test('history prefetch starts two viewports before an unloaded range', () => {
  assert.equal(getEffectiveHistoryLoadThreshold({
    configuredThreshold: 720,
    clientHeight: 752,
  }), 1504);
  assert.equal(getEffectiveHistoryLoadThreshold({
    configuredThreshold: 720,
    clientHeight: 240,
  }), 720);
});

test('a sentinel cannot manufacture demand after a scroll signal was consumed', () => {
  assert.equal(selectPreferredHistoryScrollSignal({
    preferredDirection: 'older',
    liveSignal: { direction: 'older', at: 100 },
    retainedSignal: null,
    consumedAt: 100,
    now: 200,
    ttlMs: 1500,
  }), null);
});

test('a sentinel can consume an unexpired user signal exactly once', () => {
  const signal = { direction: 'newer' as const, at: 200 };
  assert.equal(selectPreferredHistoryScrollSignal({
    preferredDirection: 'newer',
    liveSignal: signal,
    retainedSignal: null,
    consumedAt: 100,
    now: 300,
    ttlMs: 1500,
  }), signal);
  assert.equal(selectPreferredHistoryScrollSignal({
    preferredDirection: 'newer',
    liveSignal: signal,
    retainedSignal: null,
    consumedAt: 200,
    now: 300,
    ttlMs: 1500,
  }), null);
});

test('an unconsumed retained signal survives temporary loading contention', () => {
  const retainedSignal = { direction: 'older' as const, at: 400 };
  assert.equal(selectPreferredHistoryScrollSignal({
    preferredDirection: 'older',
    liveSignal: { direction: 'newer', at: 450 },
    retainedSignal,
    consumedAt: 300,
    now: 500,
    ttlMs: 1500,
  }), retainedSignal);
});
