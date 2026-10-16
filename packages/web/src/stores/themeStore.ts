'use client';

import { create } from 'zustand';

/** What is actually painted. */
export type ResolvedTheme = 'light' | 'dark';

import {
  applyPalette,
  PALETTE_STORAGE_KEY,
  type PalettePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from '@/lib/theme';

export type { PalettePreference, ThemePreference };

function readPreference(): ThemePreference {
  try {
    const p = window.localStorage.getItem(THEME_STORAGE_KEY);
    return p === 'light' || p === 'dark' || p === 'system' ? p : 'dark';
  } catch {
    return 'dark';
  }
}

function readPalette(): PalettePreference {
  try {
    return window.localStorage.getItem(PALETTE_STORAGE_KEY) === 'graphite' ? 'graphite' : 'navy';
  } catch {
    return 'navy';
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
  palette: PalettePreference;
  setPreference: (preference: ThemePreference) => void;
  setPalette: (palette: PalettePreference) => void;
  /** Re-reads the stored preferences and the OS setting; called once on mount. */
  sync: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  palette: 'navy',
  preference: 'dark',
  resolved: 'dark',
  setPalette: (palette) => {
    try {
      window.localStorage.setItem(PALETTE_STORAGE_KEY, palette);
    } catch {
      // Storage is a convenience; the palette still changes for this visit.
    }
    applyPalette(palette);
    set({ palette });
  },
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
    const palette = readPalette();
    document.documentElement.dataset.theme = resolved;
    applyPalette(palette);
    const s = get();
    if (s.preference !== preference || s.resolved !== resolved || s.palette !== palette) {
      set({ palette, preference, resolved });
    }
  },
}));
