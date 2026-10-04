// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartFrame, EmptyChart } from './chartChrome';

describe('ChartFrame', () => {
  it('names the drawing and offers the same data as a table', () => {
    render(
      <ChartFrame
        ariaLabel="Daily cost. 3 days."
        table={{ columns: ['Date', 'Cost (USD)'], rows: [['3 Jun', '$1.00']] }}
      >
        <svg />
      </ChartFrame>
    );
    expect(screen.getByRole('img', { name: 'Daily cost. 3 days.' })).toBeTruthy();
    expect(screen.getByText('View as table')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Cost (USD)' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '$1.00' })).toBeTruthy();
  });
});

describe('EmptyChart', () => {
  it('is as tall as a drawn chart', () => {
    const { container } = render(<EmptyChart />);
    expect((container.firstChild as HTMLElement).style.height).toBe('280px');
  });
});
