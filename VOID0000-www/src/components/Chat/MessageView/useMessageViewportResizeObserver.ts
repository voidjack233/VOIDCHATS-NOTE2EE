import { useEffect, type MutableRefObject, type RefObject } from 'react';

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
      const wasAtBottom = atBottomRef.current;
      void attemptInitialBottomRestore();
      void maybeAutofillOlder();

      if (wasAtBottom && !historyScrollTransactionActiveRef.current) {
        // Composer banners and the mobile keyboard resize the viewport. Keep a
        // reader who was already at present pinned there before state is synced.
        scroller.scrollTop = scroller.scrollHeight;
      } else if (
        historyScrollTransactionActiveRef.current ||
        !wasAtBottom ||
        showJumpToPresentRef.current
      ) {
        restoreViewportAnchorLock();
      }
      syncScrollState();
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
