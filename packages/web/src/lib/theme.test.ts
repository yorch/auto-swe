// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMemoryStorage } from '@/test/memoryStorage';
import { PALETTE_STORAGE_KEY, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from './theme';

/** Runs the pre-paint script the way the layout's inline <script> does. */
function runInitScript() {
  new Function(THEME_INIT_SCRIPT)();
}

const root = document.documentElement;

beforeEach(() => {
  installMemoryStorage();
  delete root.dataset.theme;
  delete root.dataset.palette;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('THEME_INIT_SCRIPT', () => {
  it('paints dark navy when nothing is stored', () => {
    runInitScript();
    expect(root.dataset.theme).toBe('dark');
    expect(root.hasAttribute('data-palette')).toBe(false);
  });

  it('applies a stored theme and a stored graphite palette before paint', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    localStorage.setItem(PALETTE_STORAGE_KEY, 'graphite');
    runInitScript();
    expect(root.dataset.theme).toBe('light');
    expect(root.dataset.palette).toBe('graphite');
  });

  it('treats navy, or anything unknown, as the attribute-free default', () => {
    root.dataset.palette = 'graphite';
    localStorage.setItem(PALETTE_STORAGE_KEY, 'navy');
    runInitScript();
    expect(root.hasAttribute('data-palette')).toBe(false);

    localStorage.setItem(PALETTE_STORAGE_KEY, 'plaid');
    runInitScript();
    expect(root.hasAttribute('data-palette')).toBe(false);
  });

  it('still paints a theme when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    runInitScript();
    expect(root.dataset.theme).toBe('dark');
    expect(root.hasAttribute('data-palette')).toBe(false);
  });
});
