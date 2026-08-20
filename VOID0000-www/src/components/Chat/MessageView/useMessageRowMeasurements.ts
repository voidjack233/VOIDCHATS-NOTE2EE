import { useLayoutEffect, type RefObject } from 'react';
import type { Density } from '../../../Services/hooks/Settings/useTheme';
import {
  captureMessageTimelineGeometry,
  isMessageGeometryDiagnosticsEnabled,
  recordMessageGeometryEvent,
  type MessageGeometryTraits,
} from './messageGeometryDiagnostics';

const MAX_MEASURED_MESSAGE_HEIGHTS = 360;

interface UseMessageRowMeasurementsOptions {
  scrollerRef: RefObject<HTMLDivElement | null>;
  density: Density;
  recordMessageHeights: (measurements: Array<{ messageId: string; height: number }>) => void;
  restoreViewportAnchorLock: () => boolean;
  visualMessagesLength: number;
  firstVisualMessageId?: string;
  lastVisualMessageId?: string;
  messageHeightCacheRef: RefObject<Map<string, number>>;
  historyScrollTransactionActiveRef: RefObject<boolean>;
  atBottomRef: RefObject<boolean>;
  showJumpToPresentRef: RefObject<boolean>;
  getMessageGeometryTraits?: (messageId: string) => MessageGeometryTraits | undefined;
}

export function useMessageRowMeasurements({
  scrollerRef,
  density,
  recordMessageHeights,
  restoreViewportAnchorLock,
  visualMessagesLength,
  firstVisualMessageId,
  lastVisualMessageId,
  messageHeightCacheRef,
  historyScrollTransactionActiveRef,
  atBottomRef,
  showJumpToPresentRef,
  getMessageGeometryTraits,
}: UseMessageRowMeasurementsOptions) {
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return undefined;
    }

    const elements = Array.from(scroller.querySelectorAll<HTMLElement>('[data-message-id]'));
    const pendingMeasurements = new Map<string, number>();
    let measurementFrame: number | null = null;
    const flushMeasurements = () => {
      measurementFrame = null;
      if (pendingMeasurements.size === 0) {
        return;
      }

      recordMessageHeights(
        Array.from(pendingMeasurements, ([messageId, height]) => ({ messageId, height })),
      );
      pendingMeasurements.clear();
    };
    const scheduleMeasurementFlush = () => {
      if (measurementFrame !== null) {
        return;
      }
      measurementFrame = window.requestAnimationFrame(flushMeasurements);
    };
    const measureElement = (element: HTMLElement, source: 'initial' | 'resize') => {
      const messageId = element.dataset.messageId;
      if (!messageId) return false;

      const measuredHeight = element.getBoundingClientRect().height;
      if (Number.isFinite(measuredHeight) && measuredHeight > 0) {
        const normalizedMessageId = String(messageId);
        const previousHeight = messageHeightCacheRef.current.get(normalizedMessageId);
        if (typeof previousHeight === 'number' && Math.abs(previousHeight - measuredHeight) <= 0.5) {
          return false;
        }

        messageHeightCacheRef.current.delete(normalizedMessageId);
        messageHeightCacheRef.current.set(normalizedMessageId, measuredHeight);
        while (messageHeightCacheRef.current.size > MAX_MEASURED_MESSAGE_HEIGHTS) {
          const oldestMessageId = messageHeightCacheRef.current.keys().next().value;
          if (typeof oldestMessageId !== 'string') {
            break;
          }
          messageHeightCacheRef.current.delete(oldestMessageId);
        }
        pendingMeasurements.set(normalizedMessageId, measuredHeight);
        scheduleMeasurementFlush();
        recordMessageGeometryEvent(
          typeof previousHeight === 'number' ? 'message_row_resize' : 'message_row_measure_initial',
          () => ({
            messageId: normalizedMessageId,
            source,
            previousHeight: typeof previousHeight === 'number' ? previousHeight : null,
            nextHeight: measuredHeight,
            delta: typeof previousHeight === 'number' ? measuredHeight - previousHeight : null,
            traits: getMessageGeometryTraits?.(normalizedMessageId) || null,
            timeline: captureMessageTimelineGeometry(scroller, {
              historyTransactionActive: historyScrollTransactionActiveRef.current,
              atBottom: atBottomRef.current,
              showJumpToPresent: showJumpToPresentRef.current,
            }),
          }),
        );
        return true;
      }

      return false;
    };

    elements.forEach((element) => measureElement(element, 'initial'));

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (measurementFrame !== null) {
          window.cancelAnimationFrame(measurementFrame);
        }
      };
    }

    const observer = new ResizeObserver((entries) => {
      let rowHeightChanged = false;
      entries.forEach((entry) => {
        if (entry.target instanceof HTMLElement) {
          rowHeightChanged = measureElement(entry.target, 'resize') || rowHeightChanged;
        }
      });

      if (rowHeightChanged) {
        const beforeCorrection = isMessageGeometryDiagnosticsEnabled()
          ? captureMessageTimelineGeometry(scroller, {
              historyTransactionActive: historyScrollTransactionActiveRef.current,
              atBottom: atBottomRef.current,
              showJumpToPresent: showJumpToPresentRef.current,
            })
          : null;
        let correction: 'pin_bottom' | 'restore_anchor' | 'none' = 'none';
        let corrected = false;
        if (atBottomRef.current && !historyScrollTransactionActiveRef.current) {
          // Reactions and late content can grow the final row without adding a
          // message. Keep a reader who was at present pinned to the new bottom.
          scroller.scrollTop = scroller.scrollHeight;
          correction = 'pin_bottom';
          corrected = true;
        } else if (
          historyScrollTransactionActiveRef.current ||
          !atBottomRef.current ||
          showJumpToPresentRef.current
        ) {
          correction = 'restore_anchor';
          corrected = restoreViewportAnchorLock();
        }
        recordMessageGeometryEvent('message_row_resize_correction', () => ({
          correction,
          corrected,
          before: beforeCorrection,
          after: captureMessageTimelineGeometry(scroller, {
            historyTransactionActive: historyScrollTransactionActiveRef.current,
            atBottom: atBottomRef.current,
            showJumpToPresent: showJumpToPresentRef.current,
          }),
        }));
      }
    });

    elements.forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      if (measurementFrame !== null) {
        window.cancelAnimationFrame(measurementFrame);
      }
    };
  }, [
    atBottomRef,
    density,
    firstVisualMessageId,
    getMessageGeometryTraits,
    historyScrollTransactionActiveRef,
    lastVisualMessageId,
    messageHeightCacheRef,
    recordMessageHeights,
    restoreViewportAnchorLock,
    scrollerRef,
    showJumpToPresentRef,
    visualMessagesLength,
  ]);
}
