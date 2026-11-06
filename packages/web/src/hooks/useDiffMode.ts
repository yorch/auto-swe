'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DiffMode } from '@/components/diff/DiffFile';
import { useAuthStore } from '@/stores/authStore';

/**
 * Which diff layout a viewer prefers, kept in this browser's localStorage only. It is a per-viewer
 * convenience, like a dismissed callout: it never reaches the server or another device, and every
 * access is guarded because storage can be absent or throw (private windows, blocked site data).
 */
const PREFIX = 'auto-swe.diff-mode.';

/** `auto-swe.diff-mode.<user id | anon>`: one viewer's choice never changes another's. */
export function diffModeStorageKey(userId?: string | null): string {
  return `${PREFIX}${userId || 'anon'}`;
}

/** What was stored, or unified when nothing usable was: the layout every viewer starts with. */
export function readDiffMode(userId?: string | null): DiffMode {
  try {
    return globalThis.localStorage?.getItem(diffModeStorageKey(userId)) === 'split'
      ? 'split'
      : 'unified';
  } catch {
    return 'unified';
  }
}

/** Returns whether the choice was persisted; a false return still applies it to this page view. */
export function writeDiffMode(mode: DiffMode, userId?: string | null): boolean {
  try {
    globalThis.localStorage.setItem(diffModeStorageKey(userId), mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * The viewer's diff layout and a way to change it. It starts as unified and takes the stored
 * choice after mount, so a server render and the first client render agree.
 */
export function useDiffMode(): { mode: DiffMode; setMode: (mode: DiffMode) => void } {
  const userId = useAuthStore((s) => s.user?.sub);
  const [mode, setModeState] = useState<DiffMode>('unified');
  useEffect(() => {
    setModeState(readDiffMode(userId));
  }, [userId]);
  const setMode = useCallback(
    (next: DiffMode) => {
      setModeState(next);
      writeDiffMode(next, userId);
    },
    [userId]
  );
  return { mode, setMode };
}
