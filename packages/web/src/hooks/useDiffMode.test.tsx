// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { installMemoryStorage } from '@/test/memoryStorage';
import { diffModeStorageKey, readDiffMode, useDiffMode, writeDiffMode } from './useDiffMode';

beforeEach(() => {
  installMemoryStorage();
  useAuthStore.setState({ user: { role: 'ENGINEER', sub: 'u1' } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.setState({ user: null });
});

describe('the stored diff mode', () => {
  it('scopes the key to the user', () => {
    expect(diffModeStorageKey('u1')).toBe('auto-swe.diff-mode.u1');
    expect(diffModeStorageKey()).toBe('auto-swe.diff-mode.anon');
    expect(diffModeStorageKey(null)).toBe('auto-swe.diff-mode.anon');
  });

  it('starts as unified and round-trips', () => {
    expect(readDiffMode('u1')).toBe('unified');
    expect(writeDiffMode('split', 'u1')).toBe(true);
    expect(readDiffMode('u1')).toBe('split');
    writeDiffMode('unified', 'u1');
    expect(readDiffMode('u1')).toBe('unified');
  });

  it('does not leak between users', () => {
    writeDiffMode('split', 'u1');
    expect(readDiffMode('u2')).toBe('unified');
    expect(readDiffMode()).toBe('unified');
  });

  it.each(['', 'sideways', 'SPLIT', '1'])('reads the stored value %j as unified', (value) => {
    localStorage.setItem(diffModeStorageKey('u1'), value);
    expect(readDiffMode('u1')).toBe('unified');
  });

  it('answers unified, and reports it did not persist, when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readDiffMode('u1')).toBe('unified');
    expect(writeDiffMode('split', 'u1')).toBe(false);
  });

  it('answers unified when there is no storage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readDiffMode('u1')).toBe('unified');
    expect(writeDiffMode('split', 'u1')).toBe(false);
  });
});

describe('useDiffMode', () => {
  it('takes the stored choice and saves a new one', () => {
    writeDiffMode('split', 'u1');
    const { result } = renderHook(() => useDiffMode());
    expect(result.current.mode).toBe('split');
    act(() => result.current.setMode('unified'));
    expect(result.current.mode).toBe('unified');
    expect(readDiffMode('u1')).toBe('unified');
  });

  it('still applies a choice for this page view when it cannot be saved', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const { result } = renderHook(() => useDiffMode());
    act(() => result.current.setMode('split'));
    expect(result.current.mode).toBe('split');
  });

  it('follows the signed-in user', () => {
    writeDiffMode('split', 'u1');
    const { result, rerender } = renderHook(() => useDiffMode());
    expect(result.current.mode).toBe('split');
    act(() => useAuthStore.setState({ user: { role: 'ENGINEER', sub: 'u2' } }));
    rerender();
    expect(result.current.mode).toBe('unified');
  });
});
