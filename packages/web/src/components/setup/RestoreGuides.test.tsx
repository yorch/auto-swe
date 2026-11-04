// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDismissed, useDismissed, writeDismissed } from '@/lib/dismissed';
import { RestoreGuides } from './RestoreGuides';

let admin = true;
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => admin }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (select: (s: { user: { sub: string } }) => unknown) =>
    select({ user: { sub: 'u1' } }),
}));

beforeEach(() => {
  localStorage.clear();
  admin = true;
});
afterEach(cleanup);

describe('RestoreGuides', () => {
  it('renders nothing while no guide is hidden', () => {
    const { container } = render(<RestoreGuides />);
    expect(container.textContent).toBe('');
  });

  it('appears when the guide is dismissed and clears the flag on request', () => {
    render(<RestoreGuides />);
    act(() => {
      writeDismissed('governance-guide', 'u1');
    });
    expect(screen.getByText('The governance guide is hidden.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show it again' }));
    expect(localStorage.getItem('auto-swe.dismissed.u1.governance-guide')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show it again' })).toBeNull();
  });

  it('tracks the first-run checklist for a non-admin', () => {
    admin = false;
    localStorage.setItem('auto-swe.dismissed.u1.first-run-checklist', '1');
    render(<RestoreGuides />);
    expect(screen.getByText('The first-run checklist is hidden.')).toBeTruthy();
  });
});

function Callout() {
  const { ready, dismissed } = useDismissed('governance-guide');
  return ready && !dismissed ? <p>callout</p> : null;
}

describe('useDismissed', () => {
  it('brings a mounted callout back when its flag is cleared elsewhere', () => {
    localStorage.setItem('auto-swe.dismissed.u1.governance-guide', '1');
    render(<Callout />);
    expect(screen.queryByText('callout')).toBeNull();
    act(() => clearDismissed('governance-guide', 'u1'));
    expect(screen.getByText('callout')).toBeTruthy();
  });
});
