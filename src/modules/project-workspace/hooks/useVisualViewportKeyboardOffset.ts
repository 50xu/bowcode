import { useEffect } from 'react';

/**
 * Below this, a viewport difference is not a keyboard: iOS reports small,
 * stale gaps (toolbar collapse, offsetTop after scroll, the moment after the
 * keyboard closes) that would otherwise lift the whole app and leave an empty
 * band under the composer.
 */
const MIN_KEYBOARD_HEIGHT_PX = 120;

/** Keeps the fixed workspace shell above the virtual keyboard in iOS Safari. */
export function useVisualViewportKeyboardOffset() {
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return undefined;
    }

    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const root = document.documentElement;
    // 100vh in px. iOS standalone PWAs under-report innerHeight by the status
    // bar while drawing full screen; the shell is sized from 100vh there, so
    // the keyboard is measured against the same full height.
    const fullHeightProbe = document.createElement('div');
    fullHeightProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100vh;visibility:hidden;pointer-events:none';
    document.body.appendChild(fullHeightProbe);

    const updateKeyboardHeight = () => {
      const fullHeight = Math.max(window.innerHeight, fullHeightProbe.offsetHeight);
      const covered = fullHeight - visualViewport.height - visualViewport.offsetTop;
      const keyboardHeight = covered >= MIN_KEYBOARD_HEIGHT_PX ? Math.round(covered) : 0;
      root.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
    };

    // iOS fires the last resize before the keyboard has finished animating
    // away (or not at all in a standalone PWA); re-measure once it settles.
    const updateAfterSettle = () => {
      updateKeyboardHeight();
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(updateKeyboardHeight, 350);
    };

    updateKeyboardHeight();
    visualViewport.addEventListener('resize', updateAfterSettle);
    visualViewport.addEventListener('scroll', updateKeyboardHeight);
    window.addEventListener('focusout', updateAfterSettle);
    window.addEventListener('orientationchange', updateAfterSettle);
    return () => {
      if (settleTimer) clearTimeout(settleTimer);
      visualViewport.removeEventListener('resize', updateAfterSettle);
      visualViewport.removeEventListener('scroll', updateKeyboardHeight);
      window.removeEventListener('focusout', updateAfterSettle);
      window.removeEventListener('orientationchange', updateAfterSettle);
      root.style.removeProperty('--keyboard-height');
      fullHeightProbe.remove();
    };
  }, []);
}
