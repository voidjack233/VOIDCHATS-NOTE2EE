import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateLcpTimingBreakdown } from '../../../src/Services/Performance/startupPerformance';
import { isDefaultAuthenticatedChatPath } from '../../../src/routeLoaders';

test('only default authenticated chat paths qualify for chat-route preload', () => {
  for (const pathname of ['/', '/home', '/chats', '/chats/732434999193640960']) {
    assert.equal(isDefaultAuthenticatedChatPath(pathname), true, pathname);
  }

  for (const pathname of ['/login', '/register', '/invite/example', '/privacy']) {
    assert.equal(isDefaultAuthenticatedChatPath(pathname), false, pathname);
  }
});

test('LCP attribution separates server, resource, and render timing', () => {
  assert.deepEqual(calculateLcpTimingBreakdown({
    lcpTime: 860.04,
    navigation: { responseStart: 120.04 },
    resource: { requestStart: 210.04, responseEnd: 640.04 },
  }), {
    lcp: 860,
    ttfb: 120,
    resourceLoadDelay: 90,
    resourceLoadDuration: 430,
    elementRenderDelay: 220,
  });
});

test('text LCP attribution reports no resource phases', () => {
  assert.deepEqual(calculateLcpTimingBreakdown({
    lcpTime: 300,
    navigation: { responseStart: 80 },
    resource: null,
  }), {
    lcp: 300,
    ttfb: 80,
    resourceLoadDelay: null,
    resourceLoadDuration: null,
    elementRenderDelay: 220,
  });
});
