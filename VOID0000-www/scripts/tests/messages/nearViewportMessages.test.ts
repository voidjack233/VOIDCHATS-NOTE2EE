import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATTACHMENT_LOAD_ROOT_MARGIN_PX,
  isMessageNearAttachmentViewport,
} from '../../../src/components/Chat/Messages/useNearViewportMessages';

test('attachment rows inside the viewport are eligible before observer delivery', () => {
  assert.equal(isMessageNearAttachmentViewport({
    messageTop: 240,
    messageBottom: 420,
    viewportTop: 100,
    viewportBottom: 700,
  }), true);
});

test('attachment rows inside the observer margin are eligible', () => {
  assert.equal(isMessageNearAttachmentViewport({
    messageTop: 700 + ATTACHMENT_LOAD_ROOT_MARGIN_PX,
    messageBottom: 900,
    viewportTop: 100,
    viewportBottom: 700,
  }), true);
  assert.equal(isMessageNearAttachmentViewport({
    messageTop: -300,
    messageBottom: 100 - ATTACHMENT_LOAD_ROOT_MARGIN_PX,
    viewportTop: 100,
    viewportBottom: 700,
  }), true);
});

test('attachment rows outside the observer margin remain deferred', () => {
  assert.equal(isMessageNearAttachmentViewport({
    messageTop: 700 + ATTACHMENT_LOAD_ROOT_MARGIN_PX + 1,
    messageBottom: 1_200,
    viewportTop: 100,
    viewportBottom: 700,
  }), false);
  assert.equal(isMessageNearAttachmentViewport({
    messageTop: -500,
    messageBottom: 100 - ATTACHMENT_LOAD_ROOT_MARGIN_PX - 1,
    viewportTop: 100,
    viewportBottom: 700,
  }), false);
});
