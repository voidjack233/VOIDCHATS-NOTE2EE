import { useEffect, type MutableRefObject, type RefObject } from 'react';
import {
  captureMessageTimelineGeometry,
  isMessageGeometryDiagnosticsEnabled,
  recordMessageGeometryEvent,
} from './messageGeometryDiagnostics';

interface UseMessageViewportResizeObserverOptions {
  scrollerRef: RefObject<HTMLDivElement | null>;
  historyScrollTransactionActiveRef: MutableRefObject<boolean>;
  atBottomRef: MutableRefObject<boolean>;
  showJumpToPresentRef: MutableRefObject<boolean>;
  attemptInitialBottomRestore: () => boolean;
  maybeAutofillOlder: () => boolean;
  restoreViewportAnchorLock: () => boolean;
  syncScrollState: () => void;
}

export type MessageViewportResizeCorrection =
  | 'initial_restore_only'
  | 'pin_bottom'
  | 'restore_anchor'
  | 'none';

export function selectMessageViewportResizeCorrection({
  initialRestorePerformed,
  wasAtBottom,
  historyTransactionActive,
  showJumpToPresent,
}: {
  initialRestorePerformed: boolean;
  wasAtBottom: boolean;
  historyTransactionActive: boolean;
  showJumpToPresent: boolean;
}): MessageViewportResizeCorrection {
  if (initialRestorePerformed) {
    return 'initial_restore_only';
  }
  if (wasAtBottom && !historyTransactionActive) {
    return 'pin_bottom';
  }
  if (historyTransactionActive || !wasAtBottom || showJumpToPresent) {
    return 'restore_anchor';
  }
  return 'none';
}

export function useMessageViewportResizeObserver({
  scrollerRef,
  historyScrollTransactionActiveRef,
  atBottomRef,
  showJumpToPresentRef,
  attemptInitialBottomRestore,
  maybeAutofillOlder,
  restoreViewportAnchorLock,
  syncScrollState,
}: UseMessageViewportResizeObserverOptions) {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      const before = isMessageGeometryDiagnosticsEnabled()
        ? captureMessageTimelineGeometry(scroller, {
            historyTransactionActive: historyScrollTransactionActiveRef.current,
            atBottom: atBottomRef.current,
            showJumpToPresent: showJumpToPresentRef.current,
          })
        : null;
      const wasAtBottom = atBottomRef.current;
      const restoredInitialPosition = attemptInitialBottomRestore();
      void maybeAutofillOlder();
      // Initial restoration recomputes atBottomRef. Never follow it with a
      // correction based on the stale pre-restore value captured above.
      const correction = selectMessageViewportResizeCorrection({
        initialRestorePerformed: restoredInitialPosition,
        wasAtBottom,
        historyTransactionActive: Boolean(historyScrollTransactionActiveRef.current),
        showJumpToPresent: showJumpToPresentRef.current,
      });

      if (correction === 'pin_bottom') {
        // Composer banners and the mobile keyboard resize the viewport. Keep a
        // reader who was already at present pinned there before state is synced.
        scroller.scrollTop = scroller.scrollHeight;
      } else if (correction === 'restore_anchor') {
        restoreViewportAnchorLock();
      }
      syncScrollState();
      recordMessageGeometryEvent('message_viewport_resize_correction', () => ({
        correction,
        before,
        after: captureMessageTimelineGeometry(scroller, {
          historyTransactionActive: historyScrollTransactionActiveRef.current,
          atBottom: atBottomRef.current,
          showJumpToPresent: showJumpToPresentRef.current,
        }),
      }));
    });

    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [
    attemptInitialBottomRestore,
    atBottomRef,
    historyScrollTransactionActiveRef,
    maybeAutofillOlder,
    restoreViewportAnchorLock,
    scrollerRef,
    showJumpToPresentRef,
    syncScrollState,
  ]);
}
