'use client';

import { useEffect } from 'react';

export const UNSAVED_CHANGES_PROMPT = 'You have unsaved changes. Leave this page and discard them?';

// Several forms on one page share a single set of listeners, so leaving with
// two dirty forms asks once, not twice.
const dirtySources = new Set<symbol>();

function onBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  // Required by some browsers to show the native "leave site?" dialog.
  event.returnValue = '';
}

/** The link a click would follow, if following it leaves the current page inside the app. */
function leavingLink(event: MouseEvent): HTMLAnchorElement | null {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return null;
  }
  const anchor = (event.target as Element | null)?.closest?.('a[href]');
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank' || anchor.download) {
    return null;
  }
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) {
    return null;
  }
  const samePage =
    url.pathname === window.location.pathname && url.search === window.location.search;
  return samePage ? null : anchor;
}

// Capture phase, so the prompt runs before Next's client router handles the click.
function onClickCapture(event: MouseEvent) {
  if (leavingLink(event) && !window.confirm(UNSAVED_CHANGES_PROMPT)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

/** True while any mounted form has unsaved edits. */
export function hasUnsavedChanges(): boolean {
  return dirtySources.size > 0;
}

function track(source: symbol) {
  if (dirtySources.size === 0) {
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClickCapture, true);
  }
  dirtySources.add(source);
}

function untrack(source: symbol) {
  dirtySources.delete(source);
  if (dirtySources.size === 0) {
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('click', onClickCapture, true);
  }
}

/**
 * Warn before the person leaves a page with unsaved edits: the browser's own
 * prompt on reload, close or an external link, and a confirm on any in-app
 * link click. The browser Back button is not intercepted — the App Router
 * exposes no hook for it — so it leaves without asking.
 */
export function useUnsavedChangesGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const source = Symbol('unsaved-changes');
    track(source);
    return () => untrack(source);
  }, [dirty]);
}
