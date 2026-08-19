// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useIntegrationConfigForm } from './useIntegrationConfigForm';

describe('useIntegrationConfigForm', () => {
  it('starts with clean state', () => {
    const { result } = renderHook(() => useIntegrationConfigForm());
    expect(result.current.saved).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.requiresRestart).toBe(false);
    expect(result.current.testing).toBe(false);
    expect(result.current.testResult).toBeNull();
  });

  it('submit runs the mutation, marks saved, and calls onSuccess with the result', async () => {
    const run = vi.fn().mockResolvedValue({ data: {} });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useIntegrationConfigForm());

    await act(async () => {
      await result.current.submit(run, onSuccess);
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith({ data: {} });
    expect(result.current.saved).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.requiresRestart).toBe(false);
  });

  it('submit captures requiresRestart from result.data.requiresRestart', async () => {
    const run = vi.fn().mockResolvedValue({ data: { requiresRestart: true } });
    const { result } = renderHook(() => useIntegrationConfigForm());

    await act(async () => {
      await result.current.submit(run);
    });

    expect(result.current.requiresRestart).toBe(true);
    expect(result.current.saved).toBe(true);
  });

  it('a rejecting submit sets error (via errMsg), leaves saved false, and skips onSuccess', async () => {
    const run = vi.fn().mockRejectedValue(new Error('kaboom'));
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useIntegrationConfigForm());

    await act(async () => {
      await result.current.submit(run, onSuccess);
    });

    expect(result.current.error).toBe('kaboom');
    expect(result.current.saved).toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('runTest stores the resolved TestResult and toggles testing off', async () => {
    const run = vi.fn().mockResolvedValue({ detail: 'connected', ok: true });
    const { result } = renderHook(() => useIntegrationConfigForm());

    await act(async () => {
      await result.current.runTest(run);
    });

    expect(result.current.testResult).toEqual({ detail: 'connected', ok: true });
    expect(result.current.testing).toBe(false);
  });

  it('a rejecting runTest stores an ok:false result with the error message', async () => {
    const run = vi.fn().mockRejectedValue(new Error('unreachable'));
    const { result } = renderHook(() => useIntegrationConfigForm());

    await act(async () => {
      await result.current.runTest(run);
    });

    expect(result.current.testResult).toEqual({ detail: 'unreachable', ok: false });
    expect(result.current.testing).toBe(false);
  });
});
