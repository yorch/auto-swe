// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTick } from './useTick';

let renders = 0;
function Probe({ active = true }: { active?: boolean }) {
  useTick(active);
  renders += 1;
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  renders = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useTick', () => {
  it('re-renders every subscriber from one shared interval', () => {
    render(
      <>
        <Probe />
        <Probe />
        <Probe />
      </>
    );
    expect(vi.getTimerCount()).toBe(1);
    renders = 0;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(renders).toBe(3);
  });

  it('stops the interval when the last subscriber leaves', () => {
    const { unmount } = render(<Probe />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no timer for an inactive caller', () => {
    render(<Probe active={false} />);
    expect(vi.getTimerCount()).toBe(0);
  });
});
