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
