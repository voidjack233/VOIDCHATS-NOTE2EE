const STARTUP_MARK_PREFIX = 'void:';
const DIAGNOSTIC_STORAGE_KEY = 'void_startup_diagnostics';

interface LargestContentfulPaintEntry extends PerformanceEntry {
  element?: Element | null;
  loadTime?: number;
  renderTime?: number;
  size?: number;
  url?: string;
}

interface LcpTimingBreakdown {
  lcp: number;
  ttfb: number;
  resourceLoadDelay: number | null;
  resourceLoadDuration: number | null;
  elementRenderDelay: number;
}

const roundTiming = (value: number) => Math.round(Math.max(0, value) * 10) / 10;

export function startupPerformanceDiagnosticsEnabled(): boolean {
  const viteEnv = (import.meta as ImportMeta & {
    env?: { DEV?: boolean; VITE_STARTUP_PERFORMANCE?: string };
  }).env;
  if (viteEnv?.DEV || viteEnv?.VITE_STARTUP_PERFORMANCE === 'true') {
    return true;
  }

  try {
    return globalThis.localStorage?.getItem(DIAGNOSTIC_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markStartupPerformance(name: string): void {
  if (!startupPerformanceDiagnosticsEnabled() || typeof performance === 'undefined') {
    return;
  }
  performance.mark(`${STARTUP_MARK_PREFIX}${name}`);
}

const completedMarks = new Set<string>();

export function markStartupPerformanceOnce(name: string): void {
  if (completedMarks.has(name)) return;
  completedMarks.add(name);
  markStartupPerformance(name);
}

export function calculateLcpTimingBreakdown({
  lcpTime,
  navigation,
  resource,
}: {
  lcpTime: number;
  navigation: Pick<PerformanceNavigationTiming, 'responseStart'> | null;
  resource: Pick<PerformanceResourceTiming, 'requestStart' | 'responseEnd'> | null;
}): LcpTimingBreakdown {
  const ttfb = navigation?.responseStart ?? 0;
  const resourceLoadDelay = resource
    ? roundTiming(resource.requestStart - ttfb)
    : null;
  const resourceLoadDuration = resource
    ? roundTiming(resource.responseEnd - resource.requestStart)
    : null;
  const renderingStartedAfter = resource?.responseEnd ?? ttfb;

  return {
    lcp: roundTiming(lcpTime),
    ttfb: roundTiming(ttfb),
    resourceLoadDelay,
    resourceLoadDuration,
    elementRenderDelay: roundTiming(lcpTime - renderingStartedAfter),
  };
}

function describeElement(element?: Element | null) {
  if (!element) return null;
  const className = element.getAttribute('class')?.trim() || null;
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    class: className?.slice(0, 240) || null,
  };
}

function redactCapabilitySignature(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl, window.location.href);
    if (url.searchParams.has('sig')) {
      url.searchParams.set('sig', '[redacted]');
    }
    return url.toString();
  } catch {
    return rawUrl.slice(0, 500);
  }
}

let diagnosticsInstalled = false;

export function installStartupPerformanceDiagnostics(): void {
  if (
    diagnosticsInstalled ||
    !startupPerformanceDiagnosticsEnabled() ||
    typeof PerformanceObserver === 'undefined'
  ) {
    return;
  }
  diagnosticsInstalled = true;
  markStartupPerformanceOnce('app-entry');

  try {
    const observer = new PerformanceObserver((entryList) => {
      const entry = entryList.getEntries().at(-1) as LargestContentfulPaintEntry | undefined;
      if (!entry) return;

      const navigation = performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined;
      const resource = entry.url
        ? performance.getEntriesByName(entry.url, 'resource')[0] as
          PerformanceResourceTiming | undefined
        : undefined;
      const lcpTime = entry.renderTime || entry.loadTime || entry.startTime;
      const marks = performance
        .getEntriesByType('mark')
        .filter((mark) => mark.name.startsWith(STARTUP_MARK_PREFIX))
        .map((mark) => ({ name: mark.name, startTime: roundTiming(mark.startTime) }));

      console.info('[VOID_PERF] LCP attribution', {
        ...calculateLcpTimingBreakdown({
          lcpTime,
          navigation: navigation ?? null,
          resource: resource ?? null,
        }),
        size: entry.size ?? null,
        element: describeElement(entry.element),
        resourceUrl: redactCapabilitySignature(entry.url),
        resourceTiming: resource ? {
          startTime: roundTiming(resource.startTime),
          requestStart: roundTiming(resource.requestStart),
          responseEnd: roundTiming(resource.responseEnd),
          transferSize: resource.transferSize,
          decodedBodySize: resource.decodedBodySize,
        } : null,
        marks,
      });
    });
    observer.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (error) {
    console.warn('[VOID_PERF] LCP diagnostics unavailable', error);
  }
}
