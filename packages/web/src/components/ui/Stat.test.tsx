// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Stat } from './Stat';

describe('Stat', () => {
  it('renders the hint line only when given one', () => {
    const { rerender } = render(<Stat label="Schedule" value="Active" />);
    expect(screen.queryByText('Next: tomorrow')).toBeNull();
    rerender(<Stat hint="Next: tomorrow" label="Schedule" value="Active" />);
    expect(screen.getByText('Next: tomorrow')).toBeTruthy();
  });

  it('applies the muted tone to the value', () => {
    render(<Stat label="Consolidated" tone="muted" value={7} />);
    expect(screen.getByText('7').className).toContain('text-paper-500');
  });
});

describe('Stat delta', () => {
  const arrow = (container: HTMLElement) => container.querySelector('svg');
  const word = (container: HTMLElement) => container.querySelector('.sr-only')?.textContent;

  it('shows direction independently of tone: spend up is an up arrow in red', () => {
    const { container } = render(
      <Stat
        delta={{ direction: 'up', tone: 'bad', value: '+40% vs previous' }}
        label="Spend"
        value="$9"
      />
    );
    expect(word(container)).toBe('Increase');
    expect(arrow(container)).toBeTruthy();
    const delta = screen.getByText(/\+40%/);
    expect(delta.className).toContain('text-danger-400');
  });

  it('shows a down arrow in green when a bad metric falls', () => {
    const { container } = render(
      <Stat
        delta={{ direction: 'down', tone: 'good', value: '−12% vs previous' }}
        label="Errors"
        value={3}
      />
    );
    expect(word(container)).toBe('Decrease');
    expect(screen.getByText(/−12%/).className).toContain('text-success-400');
  });

  it('renders a neutral metric in a calm colour, never as good or bad', () => {
    render(
      <Stat
        delta={{ direction: 'down', tone: 'neutral', value: '−40% runs' }}
        label="Runs"
        value={6}
      />
    );
    const delta = screen.getByText(/−40%/);
    expect(delta.className).toContain('text-paper-400');
    expect(delta.className).not.toContain('success');
    expect(delta.className).not.toContain('danger');
  });

  it('draws no arrow for a flat delta and says so', () => {
    const { container } = render(
      <Stat
        delta={{ direction: 'flat', tone: 'neutral', value: 'no change' }}
        label="Runs"
        value={6}
      />
    );
    expect(arrow(container)).toBeNull();
    expect(word(container)).toBe('No change');
  });

  it('infers direction from the sign for the deprecated `positive` shape', () => {
    // formatDelta's old output for "spend up 40%" (higherIsBetter: false): positive = false.
    const up = render(
      <Stat delta={{ positive: false, value: '+40% spend' }} label="Spend" value={1} />
    );
    expect(word(up.container)).toBe('Increase');
    expect(screen.getByText(/\+40%/).className).toContain('text-danger-400');
    up.unmount();

    // "Runs down 40%" on a neutral metric: positive = true, value led by U+2212.
    const down = render(
      <Stat delta={{ positive: true, value: '−40% runs' }} label="Runs" value={1} />
    );
    expect(word(down.container)).toBe('Decrease');
    down.unmount();

    const hyphen = render(
      <Stat delta={{ positive: true, value: '-3.0 pts' }} label="Rate" value={1} />
    );
    expect(word(hyphen.container)).toBe('Decrease');
  });

  it('falls back to the old positive=up reading when the value has no sign', () => {
    const { container } = render(
      <Stat delta={{ positive: true, value: 'steady' }} label="Rate" value={1} />
    );
    expect(word(container)).toBe('Increase');
  });

  it('renders the tile variant with its icon', () => {
    const { container } = render(<Stat icon="runs" label="Runs" value={4} variant="tile" />);
    expect(container.firstElementChild?.className).toContain('border-ink-400');
    expect(container.querySelector('svg')).toBeTruthy();
  });
});
