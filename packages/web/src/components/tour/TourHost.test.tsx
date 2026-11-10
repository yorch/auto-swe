// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDismissed } from '@/lib/dismissed';
import type { PageTourStep } from '@/lib/tourSteps';
import { useAuthStore } from '@/stores/authStore';
import { useHelpStore } from '@/stores/helpStore';
import { installMemoryStorage } from '@/test/memoryStorage';
import { PageTour } from './PageTour';
import { TourHost } from './TourHost';
import { TOUR_SEEN_KEY } from './tourSupport';

const STEPS: PageTourStep[] = [
  { anchor: null, body: 'First body', id: 'a', title: 'First' },
  { anchor: null, body: 'Second body', id: 'b', title: 'Second' },
];

beforeEach(() => {
  installMemoryStorage();
  useAuthStore.setState({ user: { email: 'a@x.dev', role: 'ENGINEER', sub: 'u1' } } as never);
});
afterEach(() => {
  cleanup();
  act(() => useHelpStore.setState({ pageTour: null, tourRequest: null }));
});

const request = (kind: 'product' | 'page', opener: HTMLElement | null = null) =>
  act(() => useHelpStore.getState().requestTour(kind, opener));

describe('TourHost', () => {
  it('renders nothing until a tour is requested', () => {
    render(<TourHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('runs the product tour and records it as seen when it ends', () => {
    render(<TourHost />);
    request('product');
    expect(screen.getByText('Step 1 of 9')).toBeTruthy();
    expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(true);
  });

  it('runs the registered page tour without recording the product tour as seen', () => {
    render(
      <>
        <PageTour steps={STEPS} />
        <TourHost />
      </>
    );
    request('page');
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Second body')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(false);
  });

  it('ends a page tour quietly when its page goes away', () => {
    const { rerender } = render(
      <>
        <PageTour steps={STEPS} />
        <TourHost />
      </>
    );
    request('page');
    expect(screen.getByRole('dialog')).toBeTruthy();
    rerender(<TourHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useHelpStore.getState().tourRequest).toBeNull();
    expect(readDismissed(TOUR_SEEN_KEY, 'u1')).toBe(false);
  });

  it('keeps the product tour running when the page changes', () => {
    const { rerender } = render(
      <>
        <PageTour steps={STEPS} />
        <TourHost />
      </>
    );
    request('product');
    rerender(<TourHost />);
    expect(screen.getByText('Step 1 of 9')).toBeTruthy();
  });

  it('returns focus to the element that asked for the tour', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    render(<TourHost />);
    request('product', opener);
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('ends on Escape', () => {
    render(<TourHost />);
    request('product');
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
