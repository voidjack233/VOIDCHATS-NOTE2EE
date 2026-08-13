export function installChatPerformanceCollector() {
  if (window.__voidChatPerf) return;

  const state = {
    layoutShifts: [],
    hardLcps: [],
    softNavigations: [],
    interactionPaints: [],
    timelineSamples: [],
    rowCounts: [],
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
      topVisibleMessageId: top?.row.getAttribute('data-message-id') || null,
      topVisibleMessageOffset: top ? round(top.rect.top - timelineRect.top) : null,
      bottomVisibleMessageId: bottom?.row.getAttribute('data-message-id') || null,
      pendingVisibleImages: visibleImages.filter((image) => !image.complete).length,
      failedVisibleImages: visibleImages.filter((image) => image.complete && image.naturalWidth <= 0).length,
      olderSkeleton: Boolean(timeline.querySelector('[data-history-skeleton-anchor="end"]')),
      newerSkeleton: Boolean(timeline.querySelector('[data-history-skeleton-anchor="start"]')),
      newerRange: Boolean(timeline.querySelector('[data-message-newer-range]')),
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
      sample('scroll');
    }
  }, true);

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
    export() {
      return {
        supportedEntryTypes: [...PerformanceObserver.supportedEntryTypes],
        layoutShifts: state.layoutShifts,
        hardLcps: state.hardLcps,
        softNavigations: state.softNavigations,
        interactionPaints: state.interactionPaints,
        timelineSamples: state.timelineSamples,
        rowCounts: state.rowCounts,
      };
    },
  };
}
