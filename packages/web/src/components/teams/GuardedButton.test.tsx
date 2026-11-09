// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuardedButton } from './GuardedButton';
import { OwnerChip } from './OwnerChip';
import { TeamLabel } from './TeamLabel';

afterEach(cleanup);

describe('GuardedButton', () => {
  it('acts when nothing blocks it', () => {
    const onClick = vi.fn();
    render(<GuardedButton onClick={onClick}>Cancel run</GuardedButton>);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('blocked-reason')).toBeNull();
  });

  it('is aria-disabled, focusable, ignores clicks, and exposes the reason to assistive tech', () => {
    const onClick = vi.fn();
    const reason = 'Only members of Payments or the launcher can cancel this run.';
    render(
      <GuardedButton blockedReason={reason} onClick={onClick}>
        Cancel run
      </GuardedButton>
    );
    const button = screen.getByRole('button', { name: 'Cancel run' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-describedby')).toBe(
      screen.getByTestId('blocked-reason').getAttribute('id')
    );
    expect(screen.getByRole('button', { name: 'Cancel run' }).getAttribute('title')).toBe(reason);
    expect(screen.getByTestId('blocked-reason').textContent).toBe(reason);
  });
});

describe('GuardedButton describedby', () => {
  it('keeps the caller’s aria-describedby beside the reason, blocked or not', () => {
    const { rerender } = render(
      <>
        <span id="hint">Hint</span>
        <GuardedButton aria-describedby="hint">Go</GuardedButton>
      </>
    );
    expect(screen.getByRole('button', { name: 'Go' }).getAttribute('aria-describedby')).toBe(
      'hint'
    );
    rerender(
      <>
        <span id="hint">Hint</span>
        <GuardedButton aria-describedby="hint" blockedReason="No.">
          Go
        </GuardedButton>
      </>
    );
    const ids = (
      screen.getByRole('button', { name: 'Go' }).getAttribute('aria-describedby') ?? ''
    ).split(' ');
    expect(ids).toContain('hint');
    expect(ids).toContain(screen.getByTestId('blocked-reason').getAttribute('id'));
  });
});

describe('OwnerChip and TeamLabel', () => {
  it('names the owner, and renders nothing without one', () => {
    const { container, rerender } = render(<OwnerChip ownerName="Design" />);
    expect(screen.getByText('owned by Design')).toBeTruthy();
    rerender(<OwnerChip ownerName={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('inside a team space omits the viewer’s own team and marks the others owned by', () => {
    render(
      <TeamLabel
        teams={[
          { id: 't1', name: 'Payments' },
          { id: 't2', name: 'Design' },
        ]}
        viewerTeamId="t1"
      />
    );
    expect(screen.queryByText('Payments')).toBeNull();
    expect(screen.getByText('owned by Design')).toBeTruthy();
  });

  it('keeps plain labels on global lists', () => {
    render(<TeamLabel teams={[{ id: 't2', name: 'Design' }]} />);
    expect(screen.getByText('Design')).toBeTruthy();
    expect(screen.queryByTestId('owner-chip')).toBeNull();
  });
});
