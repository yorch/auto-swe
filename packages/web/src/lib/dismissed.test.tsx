// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import {
  clearDismissed,
  dismissedStorageKey,
  readDismissed,
  useDismissed,
  writeDismissed,
} from './dismissed';

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ user: { role: 'ENGINEER', sub: 'u1' } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null });
});

describe('dismissed storage', () => {
  it('prefixes the key and scopes it to the user', () => {
    expect(dismissedStorageKey('x', 'u1')).toBe('auto-swe.dismissed.u1.x');
    expect(dismissedStorageKey('x')).toBe('auto-swe.dismissed.anon.x');
  });

  it('round-trips and clears', () => {
    expect(readDismissed('x', 'u1')).toBe(false);
    expect(writeDismissed('x', 'u1')).toBe(true);
    expect(readDismissed('x', 'u1')).toBe(true);
    clearDismissed('x', 'u1');
    expect(readDismissed('x', 'u1')).toBe(false);
  });

  it('does not leak between users', () => {
    writeDismissed('x', 'u1');
    expect(readDismissed('x', 'u2')).toBe(false);
  });

  it('never throws when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readDismissed('x')).toBe(false);
    expect(writeDismissed('x')).toBe(false);
    expect(() => clearDismissed('x')).not.toThrow();
  });
});

describe('useDismissed', () => {
  it('is ready and not dismissed on a fresh browser', () => {
    const { result } = renderHook(() => useDismissed('x'));
    expect(result.current).toMatchObject({ dismissed: false, ready: true });
  });

  it('reads a persisted flag for this user only', () => {
    writeDismissed('x', 'u1');
    expect(renderHook(() => useDismissed('x')).result.current.dismissed).toBe(true);
    useAuthStore.setState({ user: { role: 'ENGINEER', sub: 'u2' } });
    expect(renderHook(() => useDismissed('x')).result.current.dismissed).toBe(false);
  });

  it('persists a dismissal', () => {
    const { result } = renderHook(() => useDismissed('x'));
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(true);
    expect(localStorage.getItem('auto-swe.dismissed.u1.x')).toBe('1');
  });

  it('still hides for the page view when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useDismissed('x'));
    expect(result.current).toMatchObject({ dismissed: false, ready: true });
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(true);
  });

  it('is not ready, and never shows the old answer, in the render where the key changes', () => {
    writeDismissed('a', 'u1');
    const seen: Array<{ key: string; ready: boolean; dismissed: boolean }> = [];
    const { rerender } = renderHook(
      ({ k }: { k: string }) => {
        const state = useDismissed(k);
        seen.push({ dismissed: state.dismissed, key: k, ready: state.ready });
        return state;
      },
      { initialProps: { k: 'a' } }
    );
    seen.length = 0;
    rerender({ k: 'b' });
    expect(seen[0]).toEqual({ dismissed: false, key: 'b', ready: false });
    expect(seen.at(-1)).toEqual({ dismissed: false, key: 'b', ready: true });
  });
});
