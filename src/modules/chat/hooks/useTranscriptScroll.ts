import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject, WheelEvent, TouchEvent } from 'react';

import type { ChatMessage } from '@/shared/types';

const BOTTOM_THRESHOLD = 24;

type Anchor = { element: Element; timestamp: string | null; contentTop: number };
type ScrollIntent = WheelEvent<HTMLDivElement> | TouchEvent<HTMLDivElement>;

type TranscriptScrollArgs = {
  isActive: boolean;
  sessionKey: string | null;
  messages: ChatMessage[];
  visibleMessageCount: number;
  searchScrollActiveRef: MutableRefObject<boolean>;
};

/** The chat transcript's sole scrollTop owner; paging and search remain with the session hook. */
export function useTranscriptScroll({ isActive, sessionKey, messages, visibleMessageCount, searchScrollActiveRef }: TranscriptScrollArgs) {
  // The mode drives both scroll ownership and the jump-to-bottom button.
  const [isUserScrolledUp, setScrolledUpState] = useState(false);
  const modeRef = useRef<'follow' | 'free'>('follow');
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<Anchor | null>(null);
  const expectedScrollTopRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const savedScrollTopRef = useRef(0);
  const firstFreeMessageRef = useRef<string | null>(null);
  const countAtFreeRef = useRef(visibleMessageCount);
  const previousSessionKeyRef = useRef(sessionKey);
  const wasActiveRef = useRef(isActive);
  const currentMessagesRef = useRef(messages);
  const currentCountRef = useRef(visibleMessageCount);
  currentMessagesRef.current = messages;
  currentCountRef.current = visibleMessageCount;

  const contentTopOf = useCallback((container: HTMLDivElement, element: Element) =>
    element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop, []);

  const capture = useCallback((container: HTMLDivElement) => {
    const viewportTop = container.getBoundingClientRect().top;
    const rows = container.querySelectorAll('[data-transcript-row]');
    // Rows are in document order: binary-search the first one still visible,
    // so a fully loaded transcript costs O(log n) layout reads per scroll event.
    let low = 0;
    let high = rows.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (rows[mid].getBoundingClientRect().bottom > viewportTop) {
        found = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    const element = found >= 0 ? rows[found] : undefined;
    anchorRef.current = element ? {
      element,
      timestamp: element.getAttribute('data-message-timestamp'),
      contentTop: contentTopOf(container, element),
    } : null;
    savedScrollTopRef.current = container.scrollTop;
  }, [contentTopOf]);

  const setMode = useCallback((mode: 'follow' | 'free') => {
    if (modeRef.current === mode) return;
    if (mode === 'free') {
      const all = currentMessagesRef.current;
      const first = all[Math.max(0, all.length - currentCountRef.current)];
      firstFreeMessageRef.current = first ? String(first.timestamp) : null;
      countAtFreeRef.current = currentCountRef.current;
      const container = scrollContainerRef.current;
      if (container?.clientHeight) capture(container);
    } else {
      firstFreeMessageRef.current = null;
      anchorRef.current = null;
    }
    modeRef.current = mode;
    setScrolledUpState(mode === 'free');
  }, [capture]);

  const writeTop = useCallback((container: HTMLDivElement, top: number) => {
    container.scrollTop = top;
    expectedScrollTopRef.current = container.scrollTop;
    lastScrollTopRef.current = container.scrollTop;
    savedScrollTopRef.current = container.scrollTop;
  }, []);

  const reconcile = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!isActive || !container || !container.clientHeight) return;
    if (searchScrollActiveRef.current) {
      capture(container);
      return;
    }
    if (modeRef.current === 'follow') {
      const bottomTop = container.scrollHeight - container.clientHeight;
      if (Math.abs(bottomTop - container.scrollTop) >= 0.5) writeTop(container, container.scrollHeight);
    } else {
      const anchor = anchorRef.current;
      if (anchor) {
        const element = anchor.element.isConnected && container.contains(anchor.element)
          ? anchor.element
          : Array.from(container.querySelectorAll('[data-transcript-row]')).find(row => row.getAttribute('data-message-timestamp') === anchor.timestamp);
        if (element) {
          const delta = contentTopOf(container, element) - anchor.contentTop;
          if (Math.abs(delta) >= 0.5) writeTop(container, container.scrollTop + delta);
        }
      }
    }
    capture(container);
  }, [isActive, searchScrollActiveRef, capture, contentTopOf, writeTop]);

  const visibleMessages = useMemo(() => {
    const tailStart = Math.max(0, messages.length - visibleMessageCount);
    if (modeRef.current !== 'free' || !firstFreeMessageRef.current) return messages.slice(tailStart);
    const firstIndex = messages.findIndex(message => String(message.timestamp) === firstFreeMessageRef.current);
    const freeStart = firstIndex < 0 ? Math.max(0, messages.length - countAtFreeRef.current) : firstIndex;
    return messages.slice(Math.min(tailStart, freeStart));
  }, [messages, visibleMessageCount, isUserScrolledUp]);

  // Reconcile commits as well as asynchronous height changes through the same owner.
  useLayoutEffect(() => { reconcile(); }, [visibleMessages, reconcile]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (previousSessionKeyRef.current !== sessionKey) {
      previousSessionKeyRef.current = sessionKey;
      expectedScrollTopRef.current = null;
      anchorRef.current = null;
      setMode('follow');
      if (isActive && container?.clientHeight) reconcile();
    }
    const becameActive = isActive && !wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (becameActive && container?.clientHeight) {
      if (modeRef.current === 'free') writeTop(container, savedScrollTopRef.current);
      reconcile();
    }
  }, [sessionKey, isActive, setMode, reconcile, writeTop]);

  useEffect(() => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reconcile) : null;
    const observeChildren = () => {
      observer?.disconnect();
      for (const child of Array.from(container.children)) observer?.observe(child);
      reconcile();
    };
    observeChildren();
    const mutationObserver = new MutationObserver(observeChildren);
    mutationObserver.observe(container, { childList: true });
    return () => { observer?.disconnect(); mutationObserver.disconnect(); };
  }, [isActive, reconcile]);

  const onScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!isActive || !container || !container.clientHeight) return;
    const top = container.scrollTop;
    if (expectedScrollTopRef.current !== null && Math.abs(top - expectedScrollTopRef.current) <= 1) {
      expectedScrollTopRef.current = null;
      lastScrollTopRef.current = top;
      return;
    }
    expectedScrollTopRef.current = null;
    if (container.scrollHeight - top - container.clientHeight <= BOTTOM_THRESHOLD) setMode('follow');
    else if (top < lastScrollTopRef.current - 1) setMode('free');
    lastScrollTopRef.current = top;
    savedScrollTopRef.current = top;
    capture(container);
  }, [isActive, setMode, capture]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', onScroll);
    return () => container.removeEventListener('scroll', onScroll);
  }, [onScroll]);

  // Wheel-up releases follow mode before the scroll event lands, so a streamed
  // resize in the same frame cannot snap the view back. Touch drags are left to
  // the scroll event: a drag at the bottom (or a tap) produces no upward scroll
  // and must not drop follow mode.
  const handleScrollIntent = useCallback((event?: ScrollIntent) => {
    if (event && 'deltaY' in event && event.deltaY < 0) setMode('free');
  }, [setMode]);

  const setIsUserScrolledUp = useCallback((up: boolean) => { setMode(up ? 'free' : 'follow'); }, [setMode]);
  const scrollToBottom = useCallback(() => {
    setMode('follow');
    const container = scrollContainerRef.current;
    if (isActive && container?.clientHeight) writeTop(container, container.scrollHeight);
  }, [isActive, setMode, writeTop]);
  const scrollToBottomAndReset = useCallback(() => {
    setMode('follow');
    const container = scrollContainerRef.current;
    if (!isActive || !container || !container.clientHeight) return;
    container.style.overflowY = 'hidden';
    writeTop(container, container.scrollHeight);
    requestAnimationFrame(() => {
      container.style.overflowY = '';
      if (scrollContainerRef.current === container && modeRef.current === 'follow' && isActive) reconcile();
    });
  }, [isActive, setMode, writeTop, reconcile]);

  const startSearchJump = useCallback(() => { setMode('free'); }, [setMode]);

  return { scrollContainerRef, isUserScrolledUp, setIsUserScrolledUp, scrollToBottom,
    scrollToBottomAndReset, handleScrollIntent, visibleMessages, startSearchJump };
}
