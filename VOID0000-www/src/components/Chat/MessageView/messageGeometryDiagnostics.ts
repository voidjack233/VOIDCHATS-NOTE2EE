import { parseAttachments } from '../../../Services/Chat/messageAttachments';
import type { Message, ReactionMap } from '../../../Services/Chat/chatTypes';
import {
  isAudioAttachmentLayout,
  looksLikeImageAttachment,
} from '../Attachments/messageAttachmentLayout';
import {
  extractMessageTextSegments,
  getInviteCodeFromMessageUrl,
} from '../Messages/messageLinks';

const MESSAGE_GEOMETRY_DEBUG_KEY = 'void:message-geometry-debug';
const MAX_MESSAGE_GEOMETRY_EVENTS = 600;
const MAX_OBSERVED_LAYOUT_SHIFT_KEYS = 1_200;
const LAYOUT_SHIFT_CORRELATION_WINDOW_MS = 500;
const MAX_CORRELATED_EVENTS = 24;

export interface MessageGeometryTraits {
  hasText: boolean;
  imageCount: number;
  audioCount: number;
  fileCount: number;
  hasReply: boolean;
  hasReactions: boolean;
  hasLinkPreview: boolean;
  hasInviteEmbed: boolean;
}

export interface MessageGeometryDebugEntry {
  sequence: number;
  event: string;
  at: number;
  wallTime: string;
  payload?: unknown;
}

interface LayoutShiftSource {
  node?: Node | null;
  previousRect?: DOMRectReadOnly;
  currentRect?: DOMRectReadOnly;
}

interface LayoutShiftPerformanceEntry extends PerformanceEntry {
  value?: number;
  hadRecentInput?: boolean;
  sources?: LayoutShiftSource[];
}

declare global {
  interface Window {
    __VOID_MESSAGE_GEOMETRY_DEBUG__?: MessageGeometryDebugEntry[];
    clearMessageGeometryDebugReport?: () => void;
    copyMessageGeometryDebugReport?: () => Promise<string>;
  }
}

let diagnosticSequence = 0;
const observedLayoutShiftKeys = new Set<string>();

const round = (value: number) => Math.round(value * 100) / 100;

function snapshotPayload(payload: unknown): unknown {
  if (typeof payload === 'undefined') {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(payload));
  } catch {
    return { snapshotError: 'Payload could not be serialized' };
  }
}

function describeRect(rect?: DOMRectReadOnly) {
  if (!rect) return null;
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height),
  };
}

function describeShiftNode(node?: Node | null) {
  if (!(node instanceof Element)) return null;
  return {
    tag: node.tagName.toLowerCase(),
    id: node.id || null,
    className: node.getAttribute('class')?.slice(0, 240) || null,
    messageId: node.closest('[data-message-id]')?.getAttribute('data-message-id') || null,
  };
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function ensureMessageGeometryDebugHelpers() {
  if (typeof window === 'undefined') return;
  window.__VOID_MESSAGE_GEOMETRY_DEBUG__ ||= [];

  window.clearMessageGeometryDebugReport ||= () => {
    window.__VOID_MESSAGE_GEOMETRY_DEBUG__ = [];
  };
  window.copyMessageGeometryDebugReport ||= async () => {
    const report = JSON.stringify(window.__VOID_MESSAGE_GEOMETRY_DEBUG__ || [], null, 2);
    await copyText(report);
    return report;
  };
}

export function isMessageGeometryDiagnosticsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(MESSAGE_GEOMETRY_DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

export function recordMessageGeometryEvent(event: string, payload?: unknown | (() => unknown)) {
  if (!isMessageGeometryDiagnosticsEnabled() || typeof performance === 'undefined') {
    return;
  }

  ensureMessageGeometryDebugHelpers();
  const resolvedPayload = typeof payload === 'function' ? payload() : payload;
  const entry: MessageGeometryDebugEntry = {
    sequence: ++diagnosticSequence,
    event,
    at: round(performance.now()),
    wallTime: new Date().toISOString(),
    payload: snapshotPayload(resolvedPayload),
  };
  const entries = window.__VOID_MESSAGE_GEOMETRY_DEBUG__ || [];
  entries.push(entry);
  if (entries.length > MAX_MESSAGE_GEOMETRY_EVENTS) {
    entries.splice(0, entries.length - MAX_MESSAGE_GEOMETRY_EVENTS);
  }
  window.__VOID_MESSAGE_GEOMETRY_DEBUG__ = entries;
  console.debug(`[MESSAGE_GEOMETRY] ${event}`, entry);
}

export function describeMessageGeometryTraits(
  message: Message,
  reactions?: ReactionMap,
): MessageGeometryTraits {
  const attachments = parseAttachments(message.attachments);
  const imageCount = attachments.filter(looksLikeImageAttachment).length;
  const audioCount = attachments.filter(
    (attachment) => !looksLikeImageAttachment(attachment) && isAudioAttachmentLayout(attachment),
  ).length;
  const fileCount = Math.max(0, attachments.length - imageCount - audioCount);
  const hasInviteEmbed = extractMessageTextSegments(message.content || '').some(
    (segment) => segment.type === 'link' && Boolean(getInviteCodeFromMessageUrl(segment.url)),
  );

  return {
    hasText: Boolean(message.content?.trim()),
    imageCount,
    audioCount,
    fileCount,
    hasReply: Boolean(message.reply_to),
    hasReactions: Object.keys(reactions || message.reactions || {}).length > 0,
    hasLinkPreview: Boolean(message.link_preview),
    hasInviteEmbed,
  };
}

export function captureMessageTimelineGeometry(
  scroller: HTMLElement | null,
  context: Record<string, unknown> = {},
) {
  if (!scroller) {
    return { ...context, mounted: false };
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[data-message-id]'));
  const visibleRows = rows
    .map((row) => ({ row, rect: row.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom)
    .sort((left, right) => left.rect.top - right.rect.top);
  const topRange = scroller.querySelector<HTMLElement>('[data-message-older-range]');
  const bottomRange = scroller.querySelector<HTMLElement>('[data-message-newer-range]');

  return {
    ...context,
    mounted: true,
    scrollTop: round(scroller.scrollTop),
    scrollHeight: round(scroller.scrollHeight),
    clientHeight: round(scroller.clientHeight),
    clientWidth: round(scroller.clientWidth),
    scrollerRect: describeRect(scrollerRect),
    visualViewport: window.visualViewport ? {
      width: round(window.visualViewport.width),
      height: round(window.visualViewport.height),
      offsetTop: round(window.visualViewport.offsetTop),
      offsetLeft: round(window.visualViewport.offsetLeft),
      scale: round(window.visualViewport.scale),
    } : null,
    domRowCount: rows.length,
    firstDomMessageId: rows[0]?.dataset.messageId || null,
    lastDomMessageId: rows.at(-1)?.dataset.messageId || null,
    topVisibleMessageId: visibleRows[0]?.row.dataset.messageId || null,
    topVisibleMessageOffset: visibleRows[0]
      ? round(visibleRows[0].rect.top - scrollerRect.top)
      : null,
    renderedTopRangeHeight: topRange ? round(topRange.getBoundingClientRect().height) : 0,
    renderedBottomRangeHeight: bottomRange ? round(bottomRange.getBoundingClientRect().height) : 0,
  };
}

export function selectCorrelatedMessageGeometryEvents({
  entries,
  shiftStartTime,
  observedAt,
  windowMs = LAYOUT_SHIFT_CORRELATION_WINDOW_MS,
  limit = MAX_CORRELATED_EVENTS,
}: {
  entries: MessageGeometryDebugEntry[];
  shiftStartTime: number;
  observedAt: number;
  windowMs?: number;
  limit?: number;
}) {
  return entries
    .filter((entry) => (
      entry.event !== 'layout_shift' &&
      entry.at >= shiftStartTime - windowMs &&
      entry.at <= observedAt
    ))
    .slice(-limit)
    .map((entry) => ({
      ...entry,
      relativeToShiftMs: round(entry.at - shiftStartTime),
    }));
}

export function installMessageGeometryLayoutShiftObserver(
  getTimelineGeometry: () => Record<string, unknown>,
) {
  if (
    !isMessageGeometryDiagnosticsEnabled() ||
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes.includes('layout-shift')
  ) {
    return () => {};
  }

  ensureMessageGeometryDebugHelpers();
  const observer = new PerformanceObserver((list) => {
    for (const rawEntry of list.getEntries()) {
      const entry = rawEntry as LayoutShiftPerformanceEntry;
      const shiftKey = `${entry.startTime}:${entry.value ?? 0}`;
      if (observedLayoutShiftKeys.has(shiftKey)) continue;
      observedLayoutShiftKeys.add(shiftKey);
      while (observedLayoutShiftKeys.size > MAX_OBSERVED_LAYOUT_SHIFT_KEYS) {
        const oldestKey = observedLayoutShiftKeys.values().next().value;
        if (typeof oldestKey !== 'string') break;
        observedLayoutShiftKeys.delete(oldestKey);
      }
      const observedAt = performance.now();
      const precedingGeometry = selectCorrelatedMessageGeometryEvents({
        entries: window.__VOID_MESSAGE_GEOMETRY_DEBUG__ || [],
        shiftStartTime: entry.startTime,
        observedAt,
      });
      recordMessageGeometryEvent('layout_shift', {
        startTime: round(entry.startTime),
        observedAt: round(observedAt),
        value: entry.value ?? 0,
        hadRecentInput: Boolean(entry.hadRecentInput),
        sources: (entry.sources || []).map((source) => ({
          node: describeShiftNode(source.node),
          previousRect: describeRect(source.previousRect),
          currentRect: describeRect(source.currentRect),
        })),
        timeline: getTimelineGeometry(),
        correlatedGeometryEvents: precedingGeometry,
      });
    }
  });

  observer.observe({ type: 'layout-shift', buffered: true });
  return () => observer.disconnect();
}
