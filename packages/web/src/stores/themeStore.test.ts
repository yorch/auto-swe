// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PALETTE_STORAGE_KEY, THEME_STORAGE_KEY } from '@/lib/theme';
import { installMemoryStorage } from '@/test/memoryStorage';
import { useThemeStore } from './themeStore';

const root = document.documentElement;

beforeEach(() => {
  installMemoryStorage();
  useThemeStore.setState({ palette: 'navy', preference: 'dark', resolved: 'dark' });
  delete root.dataset.theme;
  delete root.dataset.palette;
});

afterEach(() => vi.unstubAllGlobals());

describe('useThemeStore palette', () => {
  it('starts on navy', () => {
    expect(useThemeStore.getState().palette).toBe('navy');
  });

  it('paints and stores graphite, and drops the attribute again for navy', () => {
    useThemeStore.getState().setPalette('graphite');
    expect(useThemeStore.getState().palette).toBe('graphite');
    expect(root.dataset.palette).toBe('graphite');
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('graphite');

    useThemeStore.getState().setPalette('navy');
    expect(root.hasAttribute('data-palette')).toBe(false);
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('navy');
  });

  it('leaves the theme alone when the palette changes, and the reverse', () => {
    useThemeStore.getState().setPreference('light');
    useThemeStore.getState().setPalette('graphite');
    expect(root.dataset.theme).toBe('light');
    useThemeStore.getState().setPreference('dark');
    expect(root.dataset.palette).toBe('graphite');
  });

  it('sync() reads both stored choices, e.g. after another tab changed them', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    localStorage.setItem(PALETTE_STORAGE_KEY, 'graphite');
    useThemeStore.getState().sync();
    expect(useThemeStore.getState()).toMatchObject({
      palette: 'graphite',
      preference: 'light',
      resolved: 'light',
    });
    expect(root.dataset.palette).toBe('graphite');
    expect(root.dataset.theme).toBe('light');
  });
});
