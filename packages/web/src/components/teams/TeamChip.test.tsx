// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamChip } from './TeamChip';

afterEach(cleanup);

describe('TeamChip', () => {
  it('names the team and removes the filter on click', () => {
    const onRemove = vi.fn();
    render(<TeamChip onRemove={onRemove} team={{ name: 'Payments' }} />);
    expect(screen.getByTestId('team-chip').textContent).toContain('Payments');
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Payments team filter' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without an active team filter', () => {
    const { container } = render(<TeamChip onRemove={() => undefined} team={null} />);
    expect(container.firstChild).toBeNull();
  });
});
