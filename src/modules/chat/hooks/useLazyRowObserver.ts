import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';

/** How far beyond the viewport a transcript row keeps (or gains) its mounted content. */
const LAZY_ROW_VIEWPORT_MARGIN_PX = 1200;

function needsManualScrollAnchoring(): boolean {
  if (typeof ResizeObserver === 'undefined' || typeof CSS === 'undefined' || !CSS.supports) return false;
  return !CSS.supports('overflow-anchor', 'auto');
}

export type LazyRowObserver = {
  /** Starts watching an element; returns the matching cleanup. */
  observe: (
    element: Element,
    onNearViewportChange: (isNearViewport: boolean) => void,
  ) => () => void;
};

/**
 * One shared IntersectionObserver for every LazyMessageRow of a transcript,
 * rooted at its scroll container. Returns null where IntersectionObserver does
 * not exist (jsdom), which keeps every row permanently mounted — the
 * pre-existing behavior.
 */
export function useLazyRowObserver(
  scrollContainerRef: RefObject<HTMLDivElement>,
): LazyRowObserver | null {
  const observerRef = useRef<IntersectionObserver | null>(null);
  const callbacksRef = useRef(new Map<Element, (isNearViewport: boolean) => void>());
  const anchorObserverRef = useRef<ResizeObserver | null>(null);
  const heightsRef = useRef(new WeakMap<Element, number>());
  const isSupported = typeof IntersectionObserver !== 'undefined';

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    anchorObserverRef.current?.disconnect();
    anchorObserverRef.current = null;
  }, []);

  /**
   * Manual scroll anchoring for engines without `overflow-anchor` (iOS Safari).
   * A row above the viewport that mounts, unmounts or reflows changes the
   * height of everything before the visible content; without anchoring that
   * shows up as the transcript jumping while the user reads. Compensating the
   * scroll offset by the same delta keeps the visible content still. Runs in
   * the ResizeObserver callback, i.e. after layout and before paint.
   */
  const getAnchorObserver = useCallback(() => {
    if (anchorObserverRef.current || !needsManualScrollAnchoring()) return anchorObserverRef.current;
    anchorObserverRef.current = new ResizeObserver((entries) => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const viewportTop = container.getBoundingClientRect().top;
      let delta = 0;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const nextHeight = element.getBoundingClientRect().height;
        const previousHeight = heightsRef.current.get(element);
        heightsRef.current.set(element, nextHeight);
        if (previousHeight === undefined || nextHeight === 0 && previousHeight === 0) continue;
        // Only rows whose top edge sits above the viewport move the content
        // the user is looking at; growth inside or below the viewport doesn't.
        if (element.getBoundingClientRect().top < viewportTop) {
          delta += nextHeight - previousHeight;
        }
      }
      // Pinned to the bottom, the stick-to-bottom logic owns the offset.
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 2;
      if (delta !== 0 && !atBottom) {
        container.scrollTop += delta;
      }
    });
    return anchorObserverRef.current;
  }, [scrollContainerRef]);

  const observe = useCallback<LazyRowObserver['observe']>((element, onNearViewportChange) => {
    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver((observerEntries) => {
        for (const entry of observerEntries) {
          // A zero-sized rect means the row is inside a display:none subtree
          // (the Chat tab is hidden), not that the user scrolled away — keep
          // the row's state, and its recorded height, intact.
          if (
            !entry.isIntersecting
            && entry.boundingClientRect.width === 0
            && entry.boundingClientRect.height === 0
          ) {
            continue;
          }
          callbacksRef.current.get(entry.target)?.(entry.isIntersecting);
        }
      }, {
        root: scrollContainerRef.current,
        rootMargin: `${LAZY_ROW_VIEWPORT_MARGIN_PX}px 0px`,
      });
    }

    callbacksRef.current.set(element, onNearViewportChange);
    observerRef.current.observe(element);
    const anchorObserver = getAnchorObserver();
    anchorObserver?.observe(element);
    return () => {
      callbacksRef.current.delete(element);
      observerRef.current?.unobserve(element);
      anchorObserver?.unobserve(element);
    };
  }, [getAnchorObserver, scrollContainerRef]);

  // Identity-stable so each row's observe effect runs once, not per render.
  return useMemo(() => (isSupported ? { observe } : null), [isSupported, observe]);
}
