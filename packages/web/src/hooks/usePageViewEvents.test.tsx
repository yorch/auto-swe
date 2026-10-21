// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { bodyOf, setupFetchMock } from '@/test/rtl-helpers';
import { resetPageViewEvents, usePageViewEvents } from './usePageViewEvents';

beforeEach(() => {
  vi.useFakeTimers();
  resetPageViewEvents();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window.navigator, 'doNotTrack');
});

const flushTimers = () => vi.advanceTimersByTimeAsync(5000);

describe('usePageViewEvents', () => {
  it('batches the pathnames it sees into one request', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/activity/ui': () => ({ accepted: 2, enabled: true }),
    });
    const { rerender } = renderHook(({ path }) => usePageViewEvents(path), {
      initialProps: { path: '/runs' },
    });
    rerender({ path: '/runs/abc' });
    await flushTimers();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(bodyOf(spy, '/api/v1/activity/ui')).toEqual({
      events: [
        { event: 'page_view', route: '/runs' },
        { event: 'page_view', route: '/runs/abc' },
      ],
    });
  });

  it('stops sending for the session once the gateway says page views are off', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/activity/ui': () => ({ accepted: 0, enabled: false }),
    });
    const { rerender } = renderHook(({ path }) => usePageViewEvents(path), {
      initialProps: { path: '/runs' },
    });
    await flushTimers();
    rerender({ path: '/agents' });
    await flushTimers();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the browser sends Do Not Track', async () => {
    Object.defineProperty(window.navigator, 'doNotTrack', { configurable: true, value: '1' });
    const spy = setupFetchMock({
      'POST /api/v1/activity/ui': () => ({ accepted: 0, enabled: true }),
    });
    renderHook(() => usePageViewEvents('/runs'));
    await flushTimers();
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends nothing when Global Privacy Control is set', async () => {
    Object.defineProperty(window.navigator, 'globalPrivacyControl', {
      configurable: true,
      value: true,
    });
    const spy = setupFetchMock({
      'POST /api/v1/activity/ui': () => ({ accepted: 0, enabled: true }),
    });
    renderHook(() => usePageViewEvents('/runs'));
    await flushTimers();
    expect(spy).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.navigator, 'globalPrivacyControl');
  });

  it('splits more than twenty views over several requests', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/activity/ui': () => ({ accepted: 20, enabled: true }),
    });
    const { rerender } = renderHook(({ path }) => usePageViewEvents(path), {
      initialProps: { path: '/runs/0' },
    });
    for (let i = 1; i < 25; i++) {
      rerender({ path: `/runs/${i}` });
    }
    await flushTimers();
    await flushTimers();
    const sizes = spy.mock.calls.map(
      ([, init]) => (JSON.parse((init as RequestInit).body as string).events as unknown[]).length
    );
    expect(sizes).toEqual([20, 5]);
  });

  it('collapses the same page repeated within a batch', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/activity/ui': () => ({ accepted: 2, enabled: true }),
    });
    const { rerender } = renderHook(({ path }) => usePageViewEvents(path), {
      initialProps: { path: '/runs' },
    });
    rerender({ path: '/agents' });
    rerender({ path: '/runs' });
    await flushTimers();
    expect(bodyOf(spy, '/api/v1/activity/ui')).toEqual({
      events: [
        { event: 'page_view', route: '/runs' },
        { event: 'page_view', route: '/agents' },
      ],
    });
  });

  it('discards what is still queued once the gateway says page views are off', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/activity/ui': () => ({ accepted: 0, enabled: false }),
    });
    const { rerender } = renderHook(({ path }) => usePageViewEvents(path), {
      initialProps: { path: '/runs/0' },
    });
    for (let i = 1; i < 25; i++) {
      rerender({ path: `/runs/${i}` });
    }
    await flushTimers();
    await flushTimers();
    await flushTimers();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('drops a different session’s leftovers when the signed-in user changes', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/activity/ui': () => ({ accepted: 1, enabled: true }),
    });
    useAuthStore.setState({ user: { role: 'ENGINEER', sub: 'u1' } } as never);
    const first = renderHook(() => usePageViewEvents('/runs'));
    first.unmount();
    useAuthStore.setState({ user: { role: 'ENGINEER', sub: 'u2' } } as never);
    renderHook(() => usePageViewEvents('/agents'));
    await flushTimers();
    expect(bodyOf(spy, '/api/v1/activity/ui')).toEqual({
      events: [{ event: 'page_view', route: '/agents' }],
    });
    useAuthStore.setState({ user: null });
  });

  it('drops a batch whose request fails, without throwing, and carries on', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', failing);
    const { rerender } = renderHook(({ path }) => usePageViewEvents(path), {
      initialProps: { path: '/runs' },
    });
    await expect(flushTimers()).resolves.not.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);
    // The failed batch is not retried; the next view goes out on its own.
    const spy = setupFetchMock({
      'POST /api/v1/activity/ui': () => ({ accepted: 1, enabled: true }),
    });
    rerender({ path: '/agents' });
    await flushTimers();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(bodyOf(spy, '/api/v1/activity/ui')).toEqual({
      events: [{ event: 'page_view', route: '/agents' }],
    });
  });
});
