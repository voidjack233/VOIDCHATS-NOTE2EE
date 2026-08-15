import { useLayoutEffect, useState } from 'react';

export const ATTACHMENT_LOAD_ROOT_MARGIN_PX = 320;
const ATTACHMENT_LOAD_ROOT_MARGIN = `${ATTACHMENT_LOAD_ROOT_MARGIN_PX}px 0px`;

export const isMessageNearAttachmentViewport = ({
  messageTop,
  messageBottom,
  viewportTop,
  viewportBottom,
  marginPx = ATTACHMENT_LOAD_ROOT_MARGIN_PX,
}: {
  messageTop: number;
  messageBottom: number;
  viewportTop: number;
  viewportBottom: number;
  marginPx?: number;
}) => (
  messageBottom >= viewportTop - marginPx &&
  messageTop <= viewportBottom + marginPx
);

const getMessageElements = (node: Node): HTMLElement[] => {
  if (!(node instanceof Element)) {
    return [];
  }

  const elements: HTMLElement[] = [];
  if (node instanceof HTMLElement && node.matches('[data-message-id]')) {
    elements.push(node);
  }
  elements.push(...node.querySelectorAll<HTMLElement>('[data-message-id]'));
  return elements;
};

export function useNearViewportMessages(
  scroller: HTMLDivElement | null,
  resetKey: string,
): ReadonlySet<string> {
  const [nearViewportState, setNearViewportState] = useState<{
    resetKey: string;
    ids: Set<string>;
  }>(() => ({ resetKey, ids: new Set() }));
  const nearViewportIds = nearViewportState.resetKey === resetKey
    ? nearViewportState.ids
    : new Set<string>();

  useLayoutEffect(() => {
    if (!scroller) {
      return undefined;
    }

    const observedElements = new Map<HTMLElement, string>();
    const updateIds = (updates: Array<{ messageId: string; isNear: boolean }>) => {
      setNearViewportState((current) => {
        const currentIds = current.resetKey === resetKey ? current.ids : new Set<string>();
        const next = new Set(currentIds);
        let changed = false;

        updates.forEach(({ messageId, isNear }) => {
          if (isNear && !next.has(messageId)) {
            next.add(messageId);
            changed = true;
          } else if (!isNear && next.delete(messageId)) {
            changed = true;
          }
        });

        return changed || current.resetKey !== resetKey
          ? { resetKey, ids: next }
          : current;
      });
    };

    const intersectionObserver = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            updateIds(entries.flatMap((entry) => {
              const messageId = observedElements.get(entry.target as HTMLElement);
              // Once a mounted row has loaded its media, keep it loaded. Turning
              // canLoad off while scrolling causes decoded images to flash back
              // to their blurhash even though the message is still rendered.
              return messageId && entry.isIntersecting
                ? [{ messageId, isNear: true }]
                : [];
            }));
          },
          {
            root: scroller,
            rootMargin: ATTACHMENT_LOAD_ROOT_MARGIN,
            threshold: 0,
          },
        );

    const observeElement = (element: HTMLElement, viewportRect: DOMRect) => {
      const messageId = element.dataset.messageId;
      if (!messageId || observedElements.has(element)) {
        return null;
      }

      observedElements.set(element, messageId);
      if (intersectionObserver) {
        intersectionObserver.observe(element);
      }

      // IntersectionObserver reports asynchronously. Seed rows that are
      // already near the viewport during layout so their image requests can
      // begin before the browser's first paint.
      const messageRect = element.getBoundingClientRect();
      return {
        messageId,
        isNear: !intersectionObserver || isMessageNearAttachmentViewport({
          messageTop: messageRect.top,
          messageBottom: messageRect.bottom,
          viewportTop: viewportRect.top,
          viewportBottom: viewportRect.bottom,
        }),
      };
    };

    const observeElements = (elements: HTMLElement[]) => {
      const viewportRect = scroller.getBoundingClientRect();
      const updates = elements
        .map((element) => observeElement(element, viewportRect))
        .filter((update): update is { messageId: string; isNear: boolean } => Boolean(update?.isNear));
      if (updates.length > 0) {
        updateIds(updates);
      }
    };

    const unobserveElement = (element: HTMLElement) => {
      const messageId = observedElements.get(element);
      if (!messageId) {
        return;
      }

      intersectionObserver?.unobserve(element);
      observedElements.delete(element);
      updateIds([{ messageId, isNear: false }]);
    };

    observeElements(getMessageElements(scroller));

    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            mutation.removedNodes.forEach((node) => {
              getMessageElements(node).forEach(unobserveElement);
            });
            mutation.addedNodes.forEach((node) => {
              observeElements(getMessageElements(node));
            });
          });
        });

    mutationObserver?.observe(scroller, { childList: true, subtree: true });

    return () => {
      mutationObserver?.disconnect();
      intersectionObserver?.disconnect();
      observedElements.clear();
    };
  }, [resetKey, scroller]);

  return nearViewportIds;
}
