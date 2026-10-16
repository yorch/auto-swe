'use client';

import { useEffect } from 'react';
import { PALETTE_STORAGE_KEY, THEME_STORAGE_KEY } from '@/lib/theme';
import { useThemeStore } from '@/stores/themeStore';

/**
 * Keeps the theme store in step with the world after hydration: the stored
 * theme and palette, the OS light/dark setting (for `system`), and other tabs
 * changing either. The first paint is handled by `THEME_INIT_SCRIPT` in <head>.
 */
export function ThemeSync() {
  const sync = useThemeStore((s) => s.sync);
  useEffect(() => {
    sync();
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY || e.key === PALETTE_STORAGE_KEY) {
        sync();
      }
    };
    window.addEventListener('storage', onStorage);
    if (typeof window.matchMedia !== 'function') {
      return () => window.removeEventListener('storage', onStorage);
    }
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      mq.removeEventListener('change', sync);
    };
  }, [sync]);
  return null;
}
