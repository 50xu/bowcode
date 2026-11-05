import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Node 25+ ships its own global Web Storage. Without `--localstorage-file`
// it is undefined, and it shadows the jsdom storage vitest installs, so every
// test touching localStorage crashed on newer Node while passing in CI (22).
// Point both globals back at jsdom's implementation.
const jsdomWindow = (globalThis as { jsdom?: { window: Window } }).jsdom?.window;
if (jsdomWindow) {
  for (const storageName of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(globalThis, storageName, {
      configurable: true,
      get: () => jsdomWindow[storageName],
    });
  }
}

// Auto-cleanup only self-registers when vitest globals are enabled, and they are
// not. Without this, a hook rendered in one test stays mounted — with its timers
// and effects live — for the rest of the file.
afterEach(cleanup);

// jsdom ships no `matchMedia`, and components that pick a layout from the
// viewport call it during render. Report the desktop breakpoint, which is the
// layout the sidebar row tests assert on.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
