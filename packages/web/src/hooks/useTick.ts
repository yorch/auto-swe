'use client';

import { useSyncExternalStore } from 'react';

const INTERVAL_MS = 30_000;

let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // One interval serves every subscriber, and runs only while there is one.
  if (timer === null) {
    timer = setInterval(() => {
      tick += 1;
      for (const notify of listeners) {
        notify();
      }
    }, INTERVAL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/**
 * Re-renders the caller every 30 s while `active`, so a relative time ("5m ago") or a deadline
 * colour does not go stale. All callers share one interval, so a page of cards costs one timer,
 * not one per card.
 */
export function useTick(active: boolean): void {
  useSyncExternalStore(
    active ? subscribe : subscribeNothing,
    () => tick,
    () => 0
  );
}

function subscribeNothing(): () => void {
  return () => {};
}
