'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * The width at which the run viewer goes from one stacked column to its side-by-side layout.
 * It is Tailwind's `lg`, so the `lg:` classes and the JS that reorders the tree agree.
 */
export const WIDE_QUERY = '(min-width: 1024px)';

/** Whether `query` matches now; `fallback` where there is no `matchMedia` (jsdom, SSR). */
export function matchesQuery(query: string, fallback: boolean): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return fallback;
  }
  return window.matchMedia(query).matches;
}

/** Subscribe to changes of `query`; a no-op where there is no `matchMedia`. */
export function subscribeToQuery(query: string, onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mq = window.matchMedia(query);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/**
 * Live `matchMedia` match. `fallback` is the answer on the server and wherever the browser
 * cannot say, so a render without a viewport behaves as the desktop layout does.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  // A stable `subscribe`: React resubscribes whenever its identity changes, and an inline arrow
  // would do that on every render (ten times a second while the replay plays).
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToQuery(query, onChange),
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => matchesQuery(query, fallback),
    () => fallback
  );
}

/**
 * True below the run viewer's breakpoint. Only the parts that must change the *order* of the
 * tree (the details panel sits between the graph and the console on a phone, after both on a
 * desktop) read this; plain styling uses `lg:` classes so it is right before any script runs.
 */
export function useIsNarrow(): boolean {
  return !useMediaQuery(WIDE_QUERY, true);
}
