// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { changedKeys, useFormState } from './useFormState';

describe('changedKeys', () => {
  it('lists only the fields whose contents differ', () => {
    expect(changedKeys({ a: 1, b: ['x'], c: 'k' }, { a: 1, b: ['x'], c: 'z' })).toEqual(['c']);
    expect(changedKeys({ a: 1, b: ['x', 'y'] }, { a: 1, b: ['x'] })).toEqual(['b']);
  });
});

describe('useFormState', () => {
  it('counts unsaved fields against the seeded baseline', () => {
    const { result } = renderHook(() => useFormState({ a: 'one', b: 2 }));
    expect(result.current.isDirty).toBe(false);

    act(() => result.current.seed({ a: 'loaded', b: 5 }));
    expect(result.current.dirtyCount).toBe(0);

    act(() => result.current.setField('a', 'edited'));
    act(() => result.current.setField('b', 6));
    expect(result.current.dirtyCount).toBe(2);

    act(() => result.current.setField('b', 5));
    expect(result.current.dirtyCount).toBe(1);
  });

  it('clears saved and error on the next edit', () => {
    const { result } = renderHook(() => useFormState({ a: 'x' }));
    act(() => result.current.markFailed('nope'));
    expect(result.current.error).toBe('nope');
    act(() => result.current.setField('a', 'y'));
    expect(result.current.error).toBeNull();

    act(() => result.current.markSaved({ a: 'y' }));
    expect(result.current.saved).toBe(true);
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.setField('a', 'z'));
    expect(result.current.saved).toBe(false);
  });

  it('discard returns to the baseline', () => {
    const { result } = renderHook(() => useFormState({ a: 'x' }));
    act(() => result.current.setField('a', 'y'));
    act(() => result.current.discard());
    expect(result.current.form).toEqual({ a: 'x' });
    expect(result.current.isDirty).toBe(false);
  });
});
