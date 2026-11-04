'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '@/stores/authStore';

/**
 * "Dismissed" flags for dashboard callouts, kept in this browser's localStorage only. They are a
 * per-viewer convenience: they never reach the server or another device, and every access is
 * guarded because storage can be absent or throw (private windows, blocked site data).
 */
const PREFIX = 'auto-swe.dismissed.';

/** `auto-swe.dismissed.<user id | anon>.<key>` — one viewer's flags never hide another's. */
export function dismissedStorageKey(key: string, userId?: string | null): string {
  return `${PREFIX}${userId || 'anon'}.${key}`;
}

export function readDismissed(key: string, userId?: string | null): boolean {
  try {
    return globalThis.localStorage?.getItem(dismissedStorageKey(key, userId)) === '1';
  } catch {
    return false;
  }
}

/**
 * Fired on this window whenever a flag is written or cleared (the `storage` event only reaches
 * other tabs), for a control that lists what is hidden. A callout re-reads on the narrower
 * `DISMISSED_CLEARED_EVENT`: re-reading after a write would un-dismiss it when storage is
 * unavailable, because the write did not persist.
 */
export const DISMISSED_CHANGE_EVENT = 'auto-swe:dismissed-change';
export const DISMISSED_CLEARED_EVENT = 'auto-swe:dismissed-cleared';

function announce(...names: string[]): void {
  try {
    for (const name of names) {
      globalThis.window?.dispatchEvent(new Event(name));
    }
  } catch {
    // No window to tell.
  }
}

/** Returns whether the flag was persisted; a false return still dismisses for this page view. */
export function writeDismissed(key: string, userId?: string | null): boolean {
  try {
    globalThis.localStorage.setItem(dismissedStorageKey(key, userId), '1');
    return true;
  } catch {
    return false;
  } finally {
    announce(DISMISSED_CHANGE_EVENT);
  }
}

export function clearDismissed(key: string, userId?: string | null): void {
  try {
    globalThis.localStorage?.removeItem(dismissedStorageKey(key, userId));
  } catch {
    // Nothing to clear when storage is unavailable.
  }
  announce(DISMISSED_CLEARED_EVENT, DISMISSED_CHANGE_EVENT);
}

/**
 * Move focus to the page's main region. Dismissing a callout unmounts the button that had focus,
 * which would otherwise drop focus to the document; the shell's `<main id="main-content">` is a
 * focusable landmark (tabIndex -1), so keyboard and screen-reader users keep their place.
 */
export function focusMainContent(): void {
  const main = globalThis.document?.getElementById('main-content');
  if (main) {
    main.focus({ preventScroll: true });
  }
}

/**
 * `ready` is false until storage has been read after mount, so a callout the viewer already
 * dismissed is never painted for a frame (and server and first client render agree). When
 * storage is unavailable the callout shows, and dismissing hides it until the page reloads.
 */
export function useDismissed(key: string): {
  ready: boolean;
  dismissed: boolean;
  dismiss: () => void;
} {
  const userId = useAuthStore((s) => s.user?.sub);
  const storageKey = dismissedStorageKey(key, userId);
  // The flag is stored with the storage key it was read for, so a key or user change reads as
  // "not ready" until the effect re-reads, never as the previous key's answer.
  const [state, setState] = useState<{ storageKey: string; dismissed: boolean } | null>(null);
  useEffect(() => {
    const read = () => setState({ dismissed: readDismissed(key, userId), storageKey });
    read();
    // A flag cleared elsewhere on the page ("Show getting-started guides") brings the callout back.
    window.addEventListener(DISMISSED_CLEARED_EVENT, read);
    return () => window.removeEventListener(DISMISSED_CLEARED_EVENT, read);
  }, [key, userId, storageKey]);
  const dismiss = useCallback(() => {
    writeDismissed(key, userId);
    setState({ dismissed: true, storageKey });
  }, [key, userId, storageKey]);
  const current = state?.storageKey === storageKey;
  return { dismiss, dismissed: current ? state.dismissed : false, ready: current };
}
