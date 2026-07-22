// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useConfigForm } from './useConfigForm';

interface FakeData {
  name: string;
  count: number;
}

interface FakeForm {
  name: string;
  count: number;
}

interface FakeBody {
  name: string;
  count: number;
}

const INITIAL: FakeForm = { count: 0, name: '' };

function toForm(data: FakeData): FakeForm {
  return { count: data.count, name: data.name };
}

function toBody(form: FakeForm): FakeBody {
  return { count: form.count, name: form.name };
}

describe('useConfigForm', () => {
  it('seeds form from initial state before data arrives, then from data once it loads', () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ data }: { data: FakeData | undefined }) =>
        useConfigForm({ data, initial: INITIAL, mutateAsync, toBody, toForm }),
      { initialProps: { data: undefined as FakeData | undefined } }
    );

    expect(result.current.form).toEqual(INITIAL);

    rerender({ data: { count: 5, name: 'loaded' } });

    expect(result.current.form).toEqual({ count: 5, name: 'loaded' });
  });

  it('setField updates a single field without touching the rest', () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useConfigForm({ data: undefined, initial: INITIAL, mutateAsync, toBody, toForm })
    );

    act(() => {
      result.current.setField('name', 'edited');
    });

    expect(result.current.form).toEqual({ count: 0, name: 'edited' });
  });

  it('submit calls mutateAsync with toBody(form) and marks saved', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useConfigForm({ data: undefined, initial: INITIAL, mutateAsync, toBody, toForm })
    );

    act(() => {
      result.current.setField('name', 'submitted');
      result.current.setField('count', 3);
    });

    await act(async () => {
      await result.current.submit();
    });

    expect(mutateAsync).toHaveBeenCalledWith({ count: 3, name: 'submitted' });
    expect(result.current.saved).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('a rejecting mutateAsync sets error and leaves saved false', async () => {
    const mutateAsync = vi.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() =>
      useConfigForm({ data: undefined, initial: INITIAL, mutateAsync, toBody, toForm })
    );

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.error).toBe('boom');
    expect(result.current.saved).toBe(false);
  });
});
