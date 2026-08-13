export const DEFAULT_RUNS = 5;

export function parsePositiveInteger(value, fallback, name, maximum = 100) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

export function parseAttachmentForClassification(rawAttachment) {
  if (rawAttachment && typeof rawAttachment === 'object') return rawAttachment;
  if (typeof rawAttachment !== 'string') return null;

  try {
    const parsed = JSON.parse(rawAttachment);
    if (parsed && typeof parsed === 'object' && typeof parsed.url === 'string') {
      return parsed;
    }
  } catch {
    // Match the application parser's legacy raw-URL fallback.
  }

  return { url: rawAttachment };
}

export function countImageAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments)) return 0;
  return rawAttachments.reduce((count, rawAttachment) => {
    const attachment = parseAttachmentForClassification(rawAttachment);
    return count + (
      typeof attachment?.mime === 'string' && attachment.mime.startsWith('image/') ? 1 : 0
    );
  }, 0);
}

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

export function summarizeValues(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { count: 0, minimum: null, median: null, p95: null, maximum: null };
  }
  const sorted = [...finite].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return {
    count: finite.length,
    minimum: Math.min(...finite),
    median,
    p95: percentile(finite, 0.95),
    maximum: Math.max(...finite),
  };
}

// CLS is the largest session window: shifts at most one second apart, capped at five seconds.
export function calculateCls(layoutShifts) {
  const shifts = layoutShifts
    .filter((entry) => !entry.hadRecentInput && Number.isFinite(entry.value))
    .sort((left, right) => left.startTime - right.startTime);
  let maximum = 0;
  let windowValue = 0;
  let windowStart = 0;
  let previousTime = 0;

  for (const shift of shifts) {
    const startsNewWindow =
      windowValue === 0 ||
      shift.startTime - previousTime > 1_000 ||
      shift.startTime - windowStart > 5_000;
    if (startsNewWindow) {
      windowStart = shift.startTime;
      windowValue = shift.value;
    } else {
      windowValue += shift.value;
    }
    previousTime = shift.startTime;
    maximum = Math.max(maximum, windowValue);
  }
  return maximum;
}

export function aggregateScenarioResults(results) {
  const groups = new Map();
  for (const result of results) {
    const key = `${result.viewport}:${result.scenario}`;
    const current = groups.get(key) || [];
    current.push(result);
    groups.set(key, current);
  }

  return [...groups.entries()].map(([key, samples]) => {
    const [viewport, scenario] = key.split(':');
    return {
      viewport,
      scenario,
      samples: samples.length,
      cls: summarizeValues(samples.map((sample) => sample.cls)),
      lcpMs: summarizeValues(samples.map((sample) => sample.lcp?.durationMs)),
      anchorDeltaPx: summarizeValues(samples.map((sample) => sample.anchor?.offsetDeltaPx)),
      failures: samples.flatMap((sample) => sample.failures || []),
    };
  });
}

export function normalizeConversationRoute(rawRoute, baseUrl) {
  if (!rawRoute) return null;
  const url = new URL(rawRoute, baseUrl);
  const base = new URL(baseUrl);
  if (url.origin !== base.origin) {
    throw new Error('CHAT_PERF_CONVERSATION_ROUTE must use the configured frontend origin');
  }
  if (!/^\/chats\/(?:@me\/)?[^/]+\/?$/.test(url.pathname)) {
    throw new Error('CHAT_PERF_CONVERSATION_ROUTE must identify one DM or group conversation');
  }
  return `${url.pathname}${url.search}`;
}
