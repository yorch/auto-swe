// @vitest-environment jsdom

import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIDEBAR_INIT_SCRIPT, SIDEBAR_STORAGE_KEY } from '@/lib/sidebar';
import { installMemoryStorage } from '@/test/memoryStorage';
import { useSidebarStore } from './sidebarStore';

beforeEach(() => {
  installMemoryStorage();
  useSidebarStore.setState({ collapsed: false });
  delete document.documentElement.dataset.sidebar;
});
afterEach(() => vi.unstubAllGlobals());

describe('sidebar preference', () => {
  it.each([null, 'invalid', 'expanded', 'collapsed'])(
    'applies %s before paint and hydrates consistently',
    (value) => {
      if (value) {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, value);
      }
      runInNewContext(SIDEBAR_INIT_SCRIPT, { document, localStorage });
      expect(document.documentElement.dataset.sidebar).toBe(
        value === 'collapsed' ? 'collapsed' : 'expanded'
      );
      useSidebarStore.getState().sync();
      expect(useSidebarStore.getState().collapsed).toBe(value === 'collapsed');
    }
  );

  it('persists both directions', () => {
    useSidebarStore.getState().toggle();
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('collapsed');
    expect(document.documentElement.dataset.sidebar).toBe('collapsed');
    useSidebarStore.getState().toggle();
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('expanded');
  });

  it('still toggles when browser storage is blocked', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    runInNewContext(SIDEBAR_INIT_SCRIPT, { document, localStorage });
    useSidebarStore.getState().sync();
    expect(document.documentElement.dataset.sidebar).toBe('expanded');
    useSidebarStore.getState().toggle();
    expect(useSidebarStore.getState().collapsed).toBe(true);
    expect(document.documentElement.dataset.sidebar).toBe('collapsed');
    read.mockRestore();
    write.mockRestore();
  });
});
