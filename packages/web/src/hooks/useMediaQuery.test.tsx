// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { clearViewport, mockViewport } from '@/test/matchMedia';
import { matchesQuery, useIsNarrow, WIDE_QUERY } from './useMediaQuery';

afterEach(() => {
  cleanup();
  clearViewport();
});

function Probe() {
  return <p data-testid="probe">{useIsNarrow() ? 'narrow' : 'wide'}</p>;
}

describe('matchesQuery', () => {
  it('answers with the fallback where the browser has no matchMedia', () => {
    clearViewport();
    expect(matchesQuery(WIDE_QUERY, true)).toBe(true);
    expect(matchesQuery(WIDE_QUERY, false)).toBe(false);
  });

  it('asks the browser when it can answer', () => {
    mockViewport(500);
    expect(matchesQuery(WIDE_QUERY, true)).toBe(false);
    mockViewport(1024);
    expect(matchesQuery(WIDE_QUERY, false)).toBe(true);
  });
});

describe('useIsNarrow', () => {
  it('is false without matchMedia, so a bare render behaves as the desktop layout', () => {
    clearViewport();
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('wide');
  });

  it('subscribes once, however often the component re-renders', () => {
    const viewport = mockViewport(500);
    let bump: () => void = () => {};
    function Ticker() {
      const [, setTick] = useState(0);
      bump = () => setTick((n) => n + 1);
      return <Probe />;
    }
    render(<Ticker />);
    for (let i = 0; i < 20; i++) {
      act(() => bump());
    }
    expect(viewport.counts.listenerAdds).toBe(1);
  });

  it('breaks exactly at 1024px, where the lg: classes do', () => {
    const viewport = mockViewport(1023);
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('narrow');
    act(() => viewport.setViewportWidth(1024));
    expect(screen.getByTestId('probe').textContent).toBe('wide');
    act(() => viewport.setViewportWidth(360));
    expect(screen.getByTestId('probe').textContent).toBe('narrow');
  });
});
