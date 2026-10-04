'use client';

import { useEffect } from 'react';

const SUFFIX = 'auto·swe';

export function formatDocumentTitle(title: string | null | undefined): string {
  return title ? `${title} · ${SUFFIX}` : SUFFIX;
}

// A page's own title (a run, a request) outranks the route's default. Effects run
// child-first, so the shell's default cannot simply be set after the page's:
// the page records its override here and the shell reads it.
let pageOverride: string | null = null;

/**
 * Sets the browser tab title for a page whose title depends on loaded data.
 * Pass `null` while the data is loading — the route's default title shows.
 */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) {
      return;
    }
    pageOverride = title;
    document.title = formatDocumentTitle(title);
    return () => {
      pageOverride = null;
    };
  }, [title]);
}

/** The shell's per-route default, applied on navigation unless a page set its own. */
export function useRouteDocumentTitle(routeTitle: string) {
  useEffect(() => {
    document.title = formatDocumentTitle(pageOverride ?? routeTitle);
  }, [routeTitle]);
}
