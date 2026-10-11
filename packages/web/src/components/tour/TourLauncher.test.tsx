// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusMainContent, readDismissed } from '@/lib/dismissed';
import { useAuthStore } from '@/stores/authStore';
import { installMemoryStorage } from '@/test/memoryStorage';
import { TOUR_SEEN_KEY, TourLauncher } from './TourLauncher';

// Pass-through spy: the real focusMainContent still runs, so tests can assert on both the call
// and the resulting focus.
vi.mock('@/lib/dismissed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dismissed')>();
  return { ...actual, focusMainContent: vi.fn(actual.focusMainContent) };
});

beforeEach(() => {
  installMemoryStorage();
  useAuthStore.setState({ user: { email: 'a@x.dev', role: 'ENGINEER', sub: 'u1' } } as never);
  vi.mocked(focusMainContent).mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.getElementById('main-content')?.remove();
});

/** The shell's focusable main landmark, as focusMainContent looks it up. */
function renderWithMain(ui: ReactElement) {
  const main = document.createElement('main');
  main.id = 'main-content';
  main.tabIndex = -1;
  document.body.appendChild(main);
  return { main, ...render(ui, { container: main }) };
}

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

  describe('focus when the tour ends', () => {
    it('returns focus to the launcher button and does not use the main-region fallback', () => {
      renderWithMain(<TourLauncher />);
      const button = screen.getByRole('button', { name: 'Take the tour' });
      fireEvent.click(button);
      for (let i = 0; i < 6; i++) {
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      }
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(document.activeElement).toBe(button);
      expect(focusMainContent).not.toHaveBeenCalled();
    });

    it('falls back to the main region when the button focus call does not take', () => {
      const { main } = renderWithMain(<TourLauncher />);
      const button = screen.getByRole('button', { name: 'Take the tour' });
      // Simulates an inert page (open mobile menu): focus() runs but activeElement is unchanged.
      const focus = vi.spyOn(button, 'focus').mockImplementation(() => {});
      fireEvent.click(button);
      fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
      expect(focus).toHaveBeenCalledTimes(1);
      expect(focusMainContent).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(main);
      expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(true);
    });

    it('lands in the open drawer when the mobile menu makes the launcher and main inert', () => {
      // jsdom has no `inert`: make focus() a no-op for anything under an [inert] ancestor.
      const realFocus = HTMLElement.prototype.focus;
      const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
        this: HTMLElement,
        options?: FocusOptions
      ) {
        if (this.closest('[inert]')) {
          return;
        }
        realFocus.call(this, options);
      });
      const drawer = document.createElement('aside');
      drawer.setAttribute('data-tour', 'sidebar');
      const close = document.createElement('button');
      close.textContent = 'Close menu';
      drawer.appendChild(close);
      document.body.appendChild(drawer);
      const page = document.createElement('div');
      page.setAttribute('inert', '');
      document.body.appendChild(page);
      const main = document.createElement('main');
      main.id = 'main-content';
      main.tabIndex = -1;
      page.appendChild(main);
      render(<TourLauncher />, { container: main });
      const button = screen.getByRole('button', { name: 'Take the tour' });
      fireEvent.click(button);
      fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
      expect(document.activeElement).not.toBe(button);
      expect(document.activeElement).not.toBe(main);
      expect(document.activeElement).toBe(close);
      expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(true);
      spy.mockRestore();
      cleanup();
      drawer.remove();
      page.remove();
    });

    it('does not move focus into a drawer that is itself inert', () => {
      const drawer = document.createElement('aside');
      drawer.setAttribute('data-tour', 'sidebar');
      drawer.setAttribute('inert', '');
      const close = document.createElement('button');
      drawer.appendChild(close);
      document.body.appendChild(drawer);
      const focus = vi.spyOn(close, 'focus');
      const { main } = renderWithMain(<TourLauncher />);
      const button = screen.getByRole('button', { name: 'Take the tour' });
      vi.spyOn(button, 'focus').mockImplementation(() => {});
      main.removeAttribute('id');
      fireEvent.click(button);
      fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
      expect(focus).not.toHaveBeenCalled();
      drawer.remove();
    });

    it('uses the main region when the launcher button is no longer in the document', () => {
      const { main } = renderWithMain(<TourLauncher />);
      const button = screen.getByRole('button', { name: 'Take the tour' });
      fireEvent.click(button);
      button.remove();
      expect(button.isConnected).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
      expect(focusMainContent).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(main);
    });

    it('never throws when neither the button nor the main region can take focus', () => {
      const { main } = renderWithMain(<TourLauncher />);
      const button = screen.getByRole('button', { name: 'Take the tour' });
      vi.spyOn(button, 'focus').mockImplementation(() => {});
      fireEvent.click(button);
      // No main region to find: focusMainContent has nothing to focus.
      main.removeAttribute('id');
      expect(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
      }).not.toThrow();
      expect(focusMainContent).toHaveBeenCalledTimes(1);
      expect(document.activeElement).not.toBe(main);
      expect(screen.getByRole('button', { name: 'Take the tour again' })).toBeTruthy();
    });
  });
});
