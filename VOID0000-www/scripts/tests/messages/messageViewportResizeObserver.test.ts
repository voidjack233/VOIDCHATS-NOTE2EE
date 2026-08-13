import assert from 'node:assert/strict';
import test from 'node:test';
import { selectMessageViewportResizeCorrection } from '../../../src/components/Chat/MessageView/useMessageViewportResizeObserver';

test('media-triggered resize does not override a completed historical restore', () => {
  assert.equal(selectMessageViewportResizeCorrection({
    initialRestorePerformed: true,
    wasAtBottom: true,
    historyTransactionActive: false,
    showJumpToPresent: false,
  }), 'initial_restore_only');
});

test('historical viewport remains anchored when a media row settles later', () => {
  assert.equal(selectMessageViewportResizeCorrection({
    initialRestorePerformed: false,
    wasAtBottom: false,
    historyTransactionActive: false,
    showJumpToPresent: true,
  }), 'restore_anchor');
});

test('at-present viewport still pins after an ordinary resize', () => {
  assert.equal(selectMessageViewportResizeCorrection({
    initialRestorePerformed: false,
    wasAtBottom: true,
    historyTransactionActive: false,
    showJumpToPresent: false,
  }), 'pin_bottom');
});

test('history transactions continue using anchor restoration', () => {
  assert.equal(selectMessageViewportResizeCorrection({
    initialRestorePerformed: false,
    wasAtBottom: true,
    historyTransactionActive: true,
    showJumpToPresent: false,
  }), 'restore_anchor');
});
