import assert from 'node:assert/strict';
import test from 'node:test';
import {
  restoreHistoryRangeReplacementAnchor,
  shouldCaptureHistoryRangeReplacement,
  shouldPreferVisibleHistoryRangeAnchor,
  type HistoryRangeReplacementSnapshot,
} from '../../../src/components/Chat/MessageView/historyScrollAnchors';

test('real visible messages take priority when the viewport straddles a history range', () => {
  assert.equal(shouldCaptureHistoryRangeReplacement({
    historyRangeVisible: true,
    hasVisibleMessageAnchor: true,
  }), false);
  assert.equal(shouldCaptureHistoryRangeReplacement({
    historyRangeVisible: true,
    hasVisibleMessageAnchor: false,
  }), true);
  assert.equal(shouldCaptureHistoryRangeReplacement({
    historyRangeVisible: false,
    hasVisibleMessageAnchor: false,
  }), false);
});

const makeReplacement = (
  anchor: HistoryRangeReplacementSnapshot['anchor'],
  direction: HistoryRangeReplacementSnapshot['direction'] = 'newer',
): HistoryRangeReplacementSnapshot => ({
  direction,
  seamMessageId: 'seam-message',
  seamAnchor: { edge: 'bottom', offset: -200 },
  sourceStart: 1_000,
  sourceEnd: 1_720,
  rowHeight: 75,
  anchor,
  rangeStartOffsetTop: 0,
  rangeEndOffsetTop: 720,
  mapped: false,
});

test('a visible skeleton row takes precedence over an off-screen seam', () => {
  assert.equal(shouldPreferVisibleHistoryRangeAnchor(makeReplacement({
    kind: 'row',
    rowIndex: 2,
    offsetTop: 90,
  })), true);
  assert.equal(shouldPreferVisibleHistoryRangeAnchor(makeReplacement({
    kind: 'start',
    offsetTop: 20,
  })), false);
  assert.equal(shouldPreferVisibleHistoryRangeAnchor(makeReplacement({
    kind: 'row',
    rowIndex: 2,
    offsetTop: 90,
  }, 'older')), true);
});

test('range replacement keeps the mapped real row at the skeleton row offset', () => {
  const replacement = makeReplacement({
    kind: 'row',
    rowIndex: 1,
    offsetTop: 90,
  });
  const scroller = {
    scrollTop: 400,
    scrollHeight: 2_000,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 100 }),
  } as unknown as HTMLElement;
  const insertedElements = [
    { getBoundingClientRect: () => ({ top: 210 }) },
    { getBoundingClientRect: () => ({ top: 350 }) },
  ] as unknown as HTMLElement[];

  restoreHistoryRangeReplacementAnchor({
    scroller,
    replacement,
    insertedElements,
    rangeStartOffsetTop: 0,
    rangeEndOffsetTop: 500,
  });

  assert.equal(scroller.scrollTop, 560);
  assert.equal(replacement.mapped, true);
});
