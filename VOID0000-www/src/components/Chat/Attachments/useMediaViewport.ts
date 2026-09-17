import { useCallback, useState } from 'react';
import { ATTACHMENT_LOAD_ROOT_MARGIN_PX } from '../Messages/useNearViewportMessages';

// Row eligibility is deliberately sticky. Check each media frame too: a long
// mixed-attachment row can intersect the viewport while its last image does not.
export function useMediaViewport(enabled: boolean) {
  const [near, setNear] = useState(false);
  const [visible, setVisible] = useState(false);

  const ref = useCallback((frame: HTMLDivElement | null) => {
    if (!enabled || !frame) return;
    const root = frame.closest('[data-message-timeline]');
    const bounds = root?.getBoundingClientRect();
    const top = Math.max(0, bounds?.top ?? 0);
    const bottom = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight);
    const rect = frame.getBoundingClientRect();
    const intersects = (margin: number) => rect.bottom > top - margin && rect.top < bottom + margin;
    // Seed visible media before paint; don't lazy-load the initial LCP candidate.
    setVisible(intersects(0));
    if (intersects(ATTACHMENT_LOAD_ROOT_MARGIN_PX)) setNear(true);
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const nearObserver = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setNear(true);
        nearObserver.disconnect();
      }
    }, { root, rootMargin: `${ATTACHMENT_LOAD_ROOT_MARGIN_PX}px 0px` });
    const visibleObserver = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { root });
    nearObserver.observe(frame);
    visibleObserver.observe(frame);
    return () => { nearObserver.disconnect(); visibleObserver.disconnect(); };
  }, [enabled]);

  return { ref, canLoad: enabled && near, loading: visible ? 'eager' as const : 'lazy' as const,
    fetchPriority: visible ? 'high' as const : 'low' as const };
}
