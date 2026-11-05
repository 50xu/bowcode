import { useCallback, useEffect, useRef, useState } from 'react';

import type { ComposerMenuAnchor } from '@/shared/types';


const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;

/**
 * Positions a composer popover above its trigger and right-aligned to it.
 *
 * Anchoring with `right`/`bottom` rather than `left`/`top` lets the menu grow
 * upward and leftward without measuring itself first, so it never paints in the
 * wrong spot for a frame. The same anchor works on phones because `maxWidth`
 * shrinks the menu instead of letting it run off the left edge.
 */
export function useComposerMenuAnchor(
  isOpen: boolean,
  onClose: () => void,
  preferredWidth = 320,
  align: 'left' | 'right' = 'right',
) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<ComposerMenuAnchor | null>(null);

  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    if (align === 'left') {
      // Left-aligned for triggers at the composer's left edge: a right-aligned
      // menu there would have to grow leftward off the screen.
      const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - preferredWidth - VIEWPORT_MARGIN));
      setAnchor({
        left,
        right: 0,
        bottom: window.innerHeight - rect.top + MENU_GAP,
        maxHeight: Math.max(160, rect.top - MENU_GAP - VIEWPORT_MARGIN),
        maxWidth: Math.max(200, Math.min(preferredWidth, window.innerWidth - left - VIEWPORT_MARGIN)),
      });
      return;
    }

    const right = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right);
    setAnchor({
      right,
      bottom: window.innerHeight - rect.top + MENU_GAP,
      maxHeight: Math.max(160, rect.top - MENU_GAP - VIEWPORT_MARGIN),
      maxWidth: Math.max(200, Math.min(preferredWidth, window.innerWidth - right - VIEWPORT_MARGIN)),
    });
  }, [align, preferredWidth]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        onClose();
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    updateAnchor();

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isOpen, onClose, updateAnchor]);

  return { triggerRef, menuRef, anchor, updateAnchor };
}
