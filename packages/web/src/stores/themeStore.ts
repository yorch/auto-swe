'use client';

import { create } from 'zustand';

/** What is actually painted. */
export type ResolvedTheme = 'light' | 'dark';

import { THEME_STORAGE_KEY, type ThemePreference } from '@/lib/theme';

export type { ThemePreference };

function readPreference(): ThemePreference {
  try {
    const p = window.localStorage.getItem(THEME_STORAGE_KEY);
    return p === 'light' || p === 'dark' || p === 'system' ? p : 'dark';
  } catch {
    return 'dark';
  }
}

function systemTheme(): ResolvedTheme {
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** Re-reads the stored preference and the OS setting; called once on mount. */
  sync: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: 'dark',
  resolved: 'dark',
  setPreference: (preference) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Storage is a convenience; the theme still changes for this visit.
    }
    const resolved = resolve(preference);
    document.documentElement.dataset.theme = resolved;
    set({ preference, resolved });
  },
  sync: () => {
    const preference = readPreference();
    const resolved = resolve(preference);
    document.documentElement.dataset.theme = resolved;
    if (get().preference !== preference || get().resolved !== resolved) {
      set({ preference, resolved });
    }
  },
}));
