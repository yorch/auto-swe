// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedUrlSearch } from './useDebouncedUrlSearch';

const trim = (v: string) => v.trim();

describe('useDebouncedUrlSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(initial = '', normalize?: (v: string) => string) {
    const write = vi.fn();
    const hook = renderHook(
      ({ url }) => useDebouncedUrlSearch(url, write, normalize ? { normalize } : undefined),
      { initialProps: { url: initial } }
    );
    return { hook, write };
  }

  it('writes the draft after a pause', () => {
    const { hook, write } = setup();
    act(() => hook.result.current[1]('abc'));
    expect(write).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(write).toHaveBeenCalledWith('abc');
  });

  it('keeps what was typed while its own write was in flight', () => {
    const { hook, write } = setup();
    act(() => hook.result.current[1]('ab'));
    act(() => vi.advanceTimersByTime(300));
    expect(write).toHaveBeenLastCalledWith('ab');
    act(() => hook.result.current[1]('abc'));
    // The write of "ab" lands after "c" was typed.
    hook.rerender({ url: 'ab' });
    expect(hook.result.current[0]).toBe('abc');
    act(() => vi.advanceTimersByTime(300));
    expect(write).toHaveBeenLastCalledWith('abc');
  });

  it('keeps the draft when an older write lands after a newer one was sent', () => {
    const { hook, write } = setup();
    act(() => hook.result.current[1]('a'));
    act(() => vi.advanceTimersByTime(300));
    act(() => hook.result.current[1]('ab'));
    act(() => vi.advanceTimersByTime(300));
    expect(write).toHaveBeenLastCalledWith('ab');
    act(() => hook.result.current[1]('abc'));
    hook.rerender({ url: 'a' });
    expect(hook.result.current[0]).toBe('abc');
    hook.rerender({ url: 'ab' });
    expect(hook.result.current[0]).toBe('abc');
  });

  it('keeps a trailing space when the URL holds the trimmed value', () => {
    const { hook, write } = setup('', trim);
    act(() => hook.result.current[1]('permission '));
    act(() => vi.advanceTimersByTime(300));
    expect(write).toHaveBeenLastCalledWith('permission');
    hook.rerender({ url: 'permission' });
    expect(hook.result.current[0]).toBe('permission ');
    act(() => hook.result.current[1]('permission denied'));
    act(() => vi.advanceTimersByTime(300));
    expect(write).toHaveBeenLastCalledWith('permission denied');
  });

  it('takes the URL value on outside navigation and drops a pending write', () => {
    const { hook, write } = setup('old');
    act(() => hook.result.current[1]('typing'));
    // Back/forward lands on another search before the pause ends.
    hook.rerender({ url: 'elsewhere' });
    expect(hook.result.current[0]).toBe('elsewhere');
    act(() => vi.advanceTimersByTime(300));
    expect(write).not.toHaveBeenCalled();
  });
});
