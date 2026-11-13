let prefetchScheduled = false;

/** Called by project-workspace once on mount, without preloading the editor on the initial page request. */
export function prefetchEditorSidebar() {
  if (prefetchScheduled || typeof window === 'undefined') return;
  prefetchScheduled = true;
  const loadEditorSidebar = () => import('@/modules/code-editor/EditorSidebar');
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => { void loadEditorSidebar(); });
  } else {
    window.setTimeout(() => { void loadEditorSidebar(); }, 200);
  }
}
