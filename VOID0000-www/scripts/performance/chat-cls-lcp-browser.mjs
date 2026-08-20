export function installChatPerformanceCollector({ enableRestoreTrace = false } = {}) {
  if (window.__voidChatPerf) return;

  const state = {
    layoutShifts: [],
    hardLcps: [],
    imageResources: [],
    softNavigations: [],
    interactionPaints: [],
    timelineSamples: [],
    rowCounts: [],
    restoreTraces: [],
    activeRestoreTrace: null,
    recentWindowSnapshot: null,
    observedTimeline: null,
    observedScrollTop: null,
    activeSampleTimer: null,
  };

  const round = (value) => Math.round(Number(value || 0) * 100) / 100;
  const describeNode = (node) => {
    if (!(node instanceof Element)) return null;
    const message = node.closest('[data-message-id]');
    const className = node.getAttribute('class')?.trim() || null;
    return {
      tag: node.tagName.toLowerCase(),
      id: node.id || null,
      class: className?.slice(0, 240) || null,
      messageId: message?.getAttribute('data-message-id') || null,
      alt: node.getAttribute('alt') || null,
      text: node.textContent?.trim().replace(/\s+/g, ' ').slice(0, 160) || null,
    };
  };
  const serializeRect = (rect) => rect ? {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height),
  } : null;
  const redactUrl = (rawUrl) => {
    if (!rawUrl) return null;
    try {
      const url = new URL(rawUrl, location.href);
      if (url.searchParams.has('sig')) url.searchParams.set('sig', '[redacted]');
      return url.toString();
    } catch {
      return String(rawUrl).slice(0, 500);
    }
  };
  const timelineSnapshot = (reason = 'sample') => {
    const timeline = document.querySelector('[data-message-timeline]');
    if (!(timeline instanceof HTMLElement)) {
      return { time: round(performance.now()), reason, mounted: false };
    }
    const timelineRect = timeline.getBoundingClientRect();
    const rows = [...timeline.querySelectorAll('[data-message-id]')];
    const visibleRows = rows
      .map((row) => ({ row, rect: row.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > timelineRect.top && rect.top < timelineRect.bottom)
      .sort((left, right) => left.rect.top - right.rect.top);
    const top = visibleRows[0] || null;
    const bottom = visibleRows.at(-1) || null;
    const visibleImages = [...timeline.querySelectorAll('img')].filter((image) => {
      const rect = image.getBoundingClientRect();
      return rect.bottom > timelineRect.top && rect.top < timelineRect.bottom;
    });
    const describeHistoryRange = (rangeSelector, skeletonSelector) => {
      const range = timeline.querySelector(rangeSelector);
      const skeleton = timeline.querySelector(skeletonSelector);
      const historySkeleton = skeleton?.querySelector('[data-history-skeleton]');
      if (!(range instanceof HTMLElement)) return null;
      return {
        rect: serializeRect(range.getBoundingClientRect()),
        inlineHeight: range.style.height || null,
        skeletonRect: historySkeleton instanceof HTMLElement
          ? serializeRect(historySkeleton.getBoundingClientRect())
          : null,
        skeletonRows: skeleton?.querySelectorAll('[data-history-skeleton-row]').length || 0,
      };
    };
    return {
      time: round(performance.now()),
      reason,
      mounted: true,
      opacity: getComputedStyle(timeline).opacity,
      scrollTop: round(timeline.scrollTop),
      scrollHeight: round(timeline.scrollHeight),
      clientHeight: round(timeline.clientHeight),
      bottomDistance: round(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight),
      rowCount: rows.length,
      firstMessageId: rows[0]?.getAttribute('data-message-id') || null,
      lastMessageId: rows.at(-1)?.getAttribute('data-message-id') || null,
      topVisibleMessageId: top?.row.getAttribute('data-message-id') || null,
      topVisibleMessageOffset: top ? round(top.rect.top - timelineRect.top) : null,
      bottomVisibleMessageId: bottom?.row.getAttribute('data-message-id') || null,
      pendingVisibleImages: visibleImages.filter((image) => !image.complete).length,
      failedVisibleImages: visibleImages.filter((image) => image.complete && image.naturalWidth <= 0).length,
      olderSkeleton: Boolean(timeline.querySelector('[data-history-skeleton-anchor="end"]')),
      newerSkeleton: Boolean(timeline.querySelector('[data-history-skeleton-anchor="start"]')),
      newerRange: Boolean(timeline.querySelector('[data-message-newer-range]')),
      olderRangeGeometry: describeHistoryRange(
        '[data-message-older-skeleton]',
        '[data-message-older-skeleton]',
      ),
      newerRangeGeometry: describeHistoryRange(
        '[data-message-newer-range]',
        '[data-message-newer-skeleton]',
      ),
    };
  };
  const cloneWindowSnapshot = (value) => ({
    loadedCount: value.loadedCount,
    hasOlder: value.hasOlder,
    topVisibleMessageId: value.topVisibleMessageId ?? null,
    topVisibleMessageOffset: Number.isFinite(value.topVisibleMessageOffset)
      ? round(value.topVisibleMessageOffset)
      : null,
    scrollTop: Number.isFinite(value.scrollTop) ? round(value.scrollTop) : null,
    wasAtBottom: value.wasAtBottom,
  });
  const isConversationWindowSnapshot = (value) => Boolean(
    value &&
    typeof value === 'object' &&
    Number.isFinite(value.loadedCount) &&
    typeof value.hasOlder === 'boolean' &&
    typeof value.wasAtBottom === 'boolean' &&
    Number.isFinite(value.scrollTop),
  );
  const targetSnapshot = (targetMessageId) => {
    if (!targetMessageId) return null;
    const timeline = document.querySelector('[data-message-timeline]');
    const row = [...document.querySelectorAll('[data-message-id]')]
      .find((element) => element.getAttribute('data-message-id') === targetMessageId);
    if (!(timeline instanceof HTMLElement) || !(row instanceof HTMLElement)) return null;
    const scrollerRect = timeline.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      messageId: targetMessageId,
      offsetTop: round(row.offsetTop),
      viewportOffset: round(rowRect.top - scrollerRect.top),
      rect: serializeRect(rowRect),
      visible: rowRect.bottom > scrollerRect.top && rowRect.top < scrollerRect.bottom,
    };
  };
  const viewportSnapshot = () => {
    const timeline = document.querySelector('[data-message-timeline]');
    const scrollerRect = timeline instanceof HTMLElement
      ? timeline.getBoundingClientRect()
      : null;
    return {
      window: {
        innerWidth: round(window.innerWidth),
        innerHeight: round(window.innerHeight),
        scrollX: round(window.scrollX),
        scrollY: round(window.scrollY),
      },
      document: {
        clientWidth: round(document.documentElement?.clientWidth),
        clientHeight: round(document.documentElement?.clientHeight),
      },
      visualViewport: window.visualViewport ? {
        width: round(window.visualViewport.width),
        height: round(window.visualViewport.height),
        offsetLeft: round(window.visualViewport.offsetLeft),
        offsetTop: round(window.visualViewport.offsetTop),
        pageLeft: round(window.visualViewport.pageLeft),
        pageTop: round(window.visualViewport.pageTop),
        scale: round(window.visualViewport.scale),
      } : null,
      scroller: timeline instanceof HTMLElement ? {
        rect: serializeRect(scrollerRect),
        scrollTop: round(timeline.scrollTop),
        scrollHeight: round(timeline.scrollHeight),
        clientHeight: round(timeline.clientHeight),
      } : null,
    };
  };
  const restoreTraceEvent = (type, detail = {}) => {
    const trace = state.activeRestoreTrace;
    if (!trace) return;
    trace.events.push({
      index: trace.events.length,
      time: round(performance.now()),
      type,
      ...viewportSnapshot(),
      target: targetSnapshot(trace.targetMessageId),
      ...detail,
    });
  };
  const savedAnchorCalculation = (timeline) => {
    const snapshot = state.recentWindowSnapshot;
    if (!snapshot?.topVisibleMessageId || snapshot.topVisibleMessageOffset === null) return null;
    const row = [...timeline.querySelectorAll('[data-message-id]')]
      .find((element) => element.getAttribute('data-message-id') === snapshot.topVisibleMessageId);
    if (!(row instanceof HTMLElement)) return null;
    const currentOffset = row.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
    return {
      messageId: snapshot.topVisibleMessageId,
      savedOffset: round(snapshot.topVisibleMessageOffset),
      currentOffset: round(currentOffset),
      calculatedDelta: round(currentOffset - snapshot.topVisibleMessageOffset),
    };
  };
  const sample = (reason) => {
    const snapshot = timelineSnapshot(reason);
    state.timelineSamples.push(snapshot);
    if (snapshot.mounted) {
      const previous = state.rowCounts.at(-1);
      if (!previous || previous.count !== snapshot.rowCount) {
        state.rowCounts.push({ time: snapshot.time, count: snapshot.rowCount });
      }
    }
    return snapshot;
  };
  const describeLcp = (entry) => ({
    startTime: round(entry.startTime),
    renderTime: round(entry.renderTime),
    loadTime: round(entry.loadTime),
    paintTime: round(entry.paintTime),
    presentationTime: round(entry.presentationTime),
    size: Number(entry.size || 0),
    navigationId: entry.navigationId ?? null,
    url: redactUrl(entry.url),
    element: describeNode(entry.element),
  });
  const describeImageResource = (entry) => ({
    url: redactUrl(entry.name),
    initiatorType: entry.initiatorType || null,
    startTime: round(entry.startTime),
    responseStart: round(entry.responseStart),
    responseEnd: round(entry.responseEnd),
    duration: round(entry.duration),
    transferSize: Number(entry.transferSize || 0),
    encodedBodySize: Number(entry.encodedBodySize || 0),
    decodedBodySize: Number(entry.decodedBodySize || 0),
    nextHopProtocol: entry.nextHopProtocol || null,
    renderBlockingStatus: entry.renderBlockingStatus || null,
  });

  const observe = (type, callback, extra = {}) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) callback(entry);
      });
      observer.observe({ type, buffered: true, ...extra });
    } catch {
      // A missing experimental option should not prevent the remaining metrics.
    }
  };

  observe('layout-shift', (entry) => {
    state.layoutShifts.push({
      startTime: round(entry.startTime),
      value: Number(entry.value || 0),
      hadRecentInput: Boolean(entry.hadRecentInput),
      navigationId: entry.navigationId ?? null,
      sources: [...(entry.sources || [])].map((source) => ({
        node: describeNode(source.node),
        previousRect: serializeRect(source.previousRect),
        currentRect: serializeRect(source.currentRect),
      })),
      timeline: timelineSnapshot('layout-shift'),
    });
  }, { includeSoftNavigationObservations: true });
  observe('largest-contentful-paint', (entry) => {
    state.hardLcps.push(describeLcp(entry));
  });
  observe('resource', (entry) => {
    if (entry.initiatorType === 'img') {
      state.imageResources.push(describeImageResource(entry));
    }
  });
  observe('interaction-contentful-paint', (entry) => {
    state.interactionPaints.push({
      startTime: round(entry.startTime),
      paintTime: round(entry.paintTime),
      presentationTime: round(entry.presentationTime),
      navigationId: entry.navigationId ?? null,
      interactionId: entry.interactionId ?? null,
      largestContentfulPaint: entry.largestContentfulPaint
        ? describeLcp(entry.largestContentfulPaint)
        : null,
    });
  }, { includeSoftNavigationObservations: true });
  observe('soft-navigation', (entry) => {
    const initialPaint = typeof entry.getLargestInteractionContentfulPaint === 'function'
      ? entry.getLargestInteractionContentfulPaint()
      : null;
    state.softNavigations.push({
      name: redactUrl(entry.name),
      startTime: round(entry.startTime),
      paintTime: round(entry.paintTime),
      presentationTime: round(entry.presentationTime),
      navigationId: entry.navigationId ?? null,
      interactionId: entry.interactionId ?? null,
      initialLargestContentfulPaint: initialPaint?.largestContentfulPaint
        ? describeLcp(initialPaint.largestContentfulPaint)
        : null,
    });
  });

  document.addEventListener('scroll', (event) => {
    if (event.target instanceof Element && event.target.matches('[data-message-timeline]')) {
      restoreTraceEvent('scroll-event');
      sample('scroll');
    }
  }, true);

  if (enableRestoreTrace) {
    const nativeMapGet = Map.prototype.get;
    const nativeMapSet = Map.prototype.set;
    Map.prototype.get = function tracedMapGet(key) {
      const value = nativeMapGet.call(this, key);
      if (state.activeRestoreTrace && isConversationWindowSnapshot(value)) {
        state.recentWindowSnapshot = cloneWindowSnapshot(value);
        restoreTraceEvent('saved-window-read', {
          cacheKey: String(key),
          savedWindow: state.recentWindowSnapshot,
        });
      }
      return value;
    };
    Map.prototype.set = function tracedMapSet(key, value) {
      if (state.activeRestoreTrace && isConversationWindowSnapshot(value)) {
        state.recentWindowSnapshot = cloneWindowSnapshot(value);
        restoreTraceEvent('saved-window-write', {
          cacheKey: String(key),
          savedWindow: state.recentWindowSnapshot,
        });
      }
      return nativeMapSet.call(this, key, value);
    };

    const scrollTopDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    if (scrollTopDescriptor?.get && scrollTopDescriptor?.set && scrollTopDescriptor.configurable) {
      Object.defineProperty(Element.prototype, 'scrollTop', {
        ...scrollTopDescriptor,
        set(value) {
          const isTimeline = this instanceof HTMLElement && this.matches('[data-message-timeline]');
          const before = isTimeline ? scrollTopDescriptor.get.call(this) : null;
          const anchorCalculation = isTimeline ? savedAnchorCalculation(this) : null;
          scrollTopDescriptor.set.call(this, value);
          if (isTimeline && state.activeRestoreTrace) {
            const after = scrollTopDescriptor.get.call(this);
            restoreTraceEvent('scrollTop-set', {
              requestedScrollTop: round(value),
              beforeScrollTop: round(before),
              afterScrollTop: round(after),
              requestedDelta: round(after - before),
              savedAnchorCalculation: anchorCalculation,
              stack: new Error().stack?.split('\n').slice(1, 7) || [],
            });
          }
        },
      });
    }

    for (const methodName of ['scrollTo', 'scrollBy']) {
      const nativeMethod = Element.prototype[methodName];
      if (typeof nativeMethod !== 'function') continue;
      Element.prototype[methodName] = function tracedScrollMethod(...args) {
        const isTimeline = this instanceof HTMLElement && this.matches('[data-message-timeline]');
        const before = isTimeline ? this.scrollTop : null;
        const result = nativeMethod.apply(this, args);
        if (isTimeline && state.activeRestoreTrace) {
          restoreTraceEvent(methodName, {
            arguments: args.map((argument) => (
              argument && typeof argument === 'object' ? { ...argument } : argument
            )),
            beforeScrollTop: round(before),
            afterScrollTop: round(this.scrollTop),
            savedAnchorCalculation: savedAnchorCalculation(this),
            stack: new Error().stack?.split('\n').slice(1, 7) || [],
          });
        }
        return result;
      };
    }
  }

  if (enableRestoreTrace && typeof window.ResizeObserver === 'function') {
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class TracedResizeObserver extends NativeResizeObserver {
      constructor(callback) {
        super((entries, observer) => {
          const relevantEntries = entries.filter((entry) => (
            entry.target instanceof Element &&
            (entry.target.matches('[data-message-timeline]') || entry.target.matches('[data-message-id]'))
          ));
          if (relevantEntries.length > 0) {
            restoreTraceEvent('resize-observer-before', {
              entries: relevantEntries.map((entry) => ({
                node: describeNode(entry.target),
                contentRect: serializeRect(entry.contentRect),
              })),
            });
          }
          callback(entries, observer);
          if (relevantEntries.length > 0) {
            restoreTraceEvent('resize-observer-after', {
              entries: relevantEntries.map((entry) => describeNode(entry.target)),
            });
          }
        });
      }
    };
  }

  if (enableRestoreTrace && typeof window.MutationObserver === 'function') {
    const historyMutationObserver = new MutationObserver((mutations) => {
      if (!state.activeRestoreTrace) return;
      const changed = [];
      const collect = (node, action) => {
        if (!(node instanceof Element)) return;
        const candidates = [
          ...(node.matches('[data-message-newer-range], [data-message-newer-skeleton], [data-history-skeleton]')
            ? [node]
            : []),
          ...node.querySelectorAll(
            '[data-message-newer-range], [data-message-newer-skeleton], [data-history-skeleton]',
          ),
        ];
        for (const candidate of candidates) {
          changed.push({
            action,
            newerRange: candidate.hasAttribute('data-message-newer-range'),
            newerSkeleton: candidate.hasAttribute('data-message-newer-skeleton'),
            anchor: candidate.getAttribute('data-history-skeleton-anchor'),
          });
        }
      };
      for (const mutation of mutations) {
        mutation.removedNodes.forEach((node) => collect(node, 'removed'));
        mutation.addedNodes.forEach((node) => collect(node, 'added'));
      }
      if (changed.length > 0) {
        restoreTraceEvent('history-range-mutation', { changed });
      }
    });
    historyMutationObserver.observe(document, { childList: true, subtree: true });
  }

  const handleViewportChange = (event) => {
    restoreTraceEvent(`viewport-${event.type}`);
  };
  if (enableRestoreTrace) {
    window.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange);
  }

  const monitorRestore = () => {
    if (state.activeRestoreTrace) {
      const timeline = document.querySelector('[data-message-timeline]');
      if (timeline !== state.observedTimeline) {
        state.observedTimeline = timeline;
        state.observedScrollTop = timeline instanceof HTMLElement ? timeline.scrollTop : null;
        restoreTraceEvent(timeline ? 'message-view-mounted' : 'message-view-unmounted');
      } else if (
        timeline instanceof HTMLElement &&
        state.observedScrollTop !== null &&
        Math.abs(timeline.scrollTop - state.observedScrollTop) > 0.5
      ) {
        restoreTraceEvent('observed-scroll-change', {
          beforeScrollTop: round(state.observedScrollTop),
          afterScrollTop: round(timeline.scrollTop),
          observedDelta: round(timeline.scrollTop - state.observedScrollTop),
        });
        state.observedScrollTop = timeline.scrollTop;
      }
      if (timeline instanceof HTMLElement) state.observedScrollTop = timeline.scrollTop;
    }
    if (enableRestoreTrace) requestAnimationFrame(monitorRestore);
  };
  if (enableRestoreTrace) requestAnimationFrame(monitorRestore);

  window.__voidChatPerf = {
    startWindow(label) {
      if (state.activeSampleTimer !== null) clearInterval(state.activeSampleTimer);
      const startTime = round(performance.now());
      sample(`${label}:start`);
      state.activeSampleTimer = setInterval(() => sample(`${label}:interval`), 50);
      return startTime;
    },
    endWindow(label) {
      if (state.activeSampleTimer !== null) {
        clearInterval(state.activeSampleTimer);
        state.activeSampleTimer = null;
      }
      sample(`${label}:end`);
      return round(performance.now());
    },
    snapshot: timelineSnapshot,
    beginRestoreTrace(label, targetMessageId) {
      state.activeRestoreTrace = {
        label,
        targetMessageId: targetMessageId || null,
        startedAt: round(performance.now()),
        events: [],
      };
      state.recentWindowSnapshot = null;
      state.observedTimeline = document.querySelector('[data-message-timeline]');
      state.observedScrollTop = state.observedTimeline instanceof HTMLElement
        ? state.observedTimeline.scrollTop
        : null;
      restoreTraceEvent('trace-start');
    },
    markRestoreTrace(label, detail = {}) {
      restoreTraceEvent(label, detail);
    },
    endRestoreTrace() {
      if (!state.activeRestoreTrace) return null;
      restoreTraceEvent('trace-end');
      const completed = state.activeRestoreTrace;
      state.restoreTraces.push(completed);
      state.activeRestoreTrace = null;
      state.recentWindowSnapshot = null;
      return completed;
    },
    export() {
      return {
        supportedEntryTypes: [...PerformanceObserver.supportedEntryTypes],
        layoutShifts: state.layoutShifts,
        hardLcps: state.hardLcps,
        imageResources: state.imageResources,
        softNavigations: state.softNavigations,
        interactionPaints: state.interactionPaints,
        timelineSamples: state.timelineSamples,
        rowCounts: state.rowCounts,
        restoreTraces: state.restoreTraces,
        messageGeometryEvents: Array.isArray(window.__VOID_MESSAGE_GEOMETRY_DEBUG__)
          ? window.__VOID_MESSAGE_GEOMETRY_DEBUG__
          : [],
        startupMarks: performance
          .getEntriesByType('mark')
          .filter((entry) => entry.name.startsWith('void:'))
          .map((entry) => ({ name: entry.name, startTime: round(entry.startTime) })),
      };
    },
  };
}
