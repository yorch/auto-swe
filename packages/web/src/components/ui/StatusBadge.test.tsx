// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusBadge } from './StatusBadge';

afterEach(cleanup);

function dotOf(text: string) {
  const badge = screen.getByText(text).parentElement as HTMLElement;
  return { badge, dot: badge.querySelector('span[aria-hidden]') as HTMLElement };
}

describe('StatusBadge', () => {
  it('shows the status as words beside a coloured dot', () => {
    render(<StatusBadge status="AWAITING_CI" />);
    const { badge, dot } = dotOf('awaiting ci');
    expect(dot.className).toContain('bg-amber-400');
    expect(dot.className).toContain('rounded-full');
    // The words stay in body colour: the dot carries the status colour.
    expect(badge.className).toContain('text-paper-300');
  });

  it('draws no bordered or filled pill around the status', () => {
    render(<StatusBadge status="FAILED" />);
    const { badge } = dotOf('failed');
    expect(badge.className).not.toMatch(/\bborder\b|border-|bg-|rounded/);
  });

  it('pulses the dot while the work is live', () => {
    render(<StatusBadge status="RUNNING" />);
    expect(dotOf('running').dot.className).toContain('pulse-dot');
  });

  it('keeps violet for actions and selection: in-flight work is blue', () => {
    render(<StatusBadge status="IMPLEMENTING" />);
    const { dot } = dotOf('implementing');
    expect(dot.className).toContain('bg-dust-400');
    expect(dot.className).not.toContain('ember');
  });

  it('falls back to a neutral dot for an unknown status', () => {
    render(<StatusBadge status="SOMETHING_NEW" />);
    expect(dotOf('something new').dot.className).toContain('bg-paper-600');
  });
});
