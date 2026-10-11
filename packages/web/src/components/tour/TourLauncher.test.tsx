// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDismissed } from '@/lib/dismissed';
import { useAuthStore } from '@/stores/authStore';
import { installMemoryStorage } from '@/test/memoryStorage';
import { TOUR_SEEN_KEY, TourLauncher } from './TourLauncher';

beforeEach(() => {
  installMemoryStorage();
  useAuthStore.setState({ user: { email: 'a@x.dev', role: 'ENGINEER', sub: 'u1' } } as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TourLauncher', () => {
  it('offers the tour but never starts it by itself', () => {
    render(<TourLauncher />);
    expect(screen.getByRole('button', { name: 'Take the tour' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('starts the tour on click, as the engineer tour', () => {
    render(<TourLauncher />);
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Step 1 of 7')).toBeTruthy();
  });

  it('shows more steps to an admin', () => {
    useAuthStore.setState({ user: { email: 'a@x.dev', role: 'ADMIN', sub: 'u1' } } as never);
    render(<TourLauncher />);
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }));
    expect(screen.getByText('Step 1 of 11')).toBeTruthy();
  });

  it('does not mark the tour seen until it ends', () => {
    render(<TourLauncher />);
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }));
    expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(false);
  });

  it('reports expanded state while the tour runs', () => {
    render(<TourLauncher />);
    const button = screen.getByRole('button', { name: 'Take the tour' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('ends the tour cleanly when the page is left: seen, outline restored, listeners gone', () => {
    const link = document.createElement('a');
    link.setAttribute('data-tour', 'nav:/start');
    link.href = '/start';
    document.body.appendChild(link);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const size = this.getAttribute('data-tour') ? 40 : 0;
      return {
        bottom: size,
        height: size,
        left: 0,
        right: size,
        toJSON: () => ({}),
        top: 0,
        width: size,
        x: 0,
        y: 0,
      };
    });
    const { unmount } = render(<TourLauncher />);
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(link.style.outline).toContain('2px solid');
    expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(false);
    unmount();
    expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(true);
    expect(link.style.outline).toBe('');
    expect(link.hasAttribute('data-tour-active')).toBe(false);
    document.body.removeChild(link);
    vi.restoreAllMocks();
  });

  it('does not mark the tour seen when the page is left without having started it', () => {
    const { unmount } = render(<TourLauncher />);
    unmount();
    expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(false);
  });

  it('records the tour as seen on Skip, switches to "Take the tour again" and refocuses the launcher', () => {
    render(<TourLauncher />);
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const again = screen.getByRole('button', { name: 'Take the tour again' });
    expect(document.activeElement).toBe(again);
    expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(true);
  });

  it('records the tour as seen on Escape and on Done', () => {
    const { unmount } = render(<TourLauncher />);
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }));
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(true);
    unmount();

    localStorage.clear();
    render(<TourLauncher />);
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }));
    for (let i = 0; i < 6; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(true);
  });

  it('shows "Take the tour again" from the first paint once seen, and can rerun it', () => {
    localStorage.setItem('auto-swe.dismissed.u1.product-tour', '1');
    render(<TourLauncher />);
    expect(screen.queryByRole('button', { name: 'Take the tour' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour again' }));
    expect(screen.getByText('Step 1 of 7')).toBeTruthy();
  });

  it('keeps one viewer\'s "seen" from affecting another', () => {
    localStorage.setItem('auto-swe.dismissed.someone-else.product-tour', '1');
    render(<TourLauncher />);
    expect(screen.getByRole('button', { name: 'Take the tour' })).toBeTruthy();
  });

  it('still works when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    render(<TourLauncher />);
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(screen.getByRole('button', { name: 'Take the tour again' })).toBeTruthy();
  });
});
