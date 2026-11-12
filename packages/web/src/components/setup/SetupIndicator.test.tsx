// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Readiness } from '@/hooks/useReadiness';
import { SetupIndicator } from './SetupIndicator';

let admin = true;
let isError = false;
let readiness: Readiness | undefined;
let pathname = '/requests';
const incomplete: Readiness = {
  gaps: [],
  items: [
    {
      detail: 'No credential.',
      href: '/models?tab=credentials',
      id: 'credentials',
      label: 'Model provider credentials',
      ok: false,
    },
    { detail: 'Ready', href: '/admin/integrations', id: 'github', label: 'GitHub', ok: true },
  ],
  providers: [],
  ready: false,
};
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => admin }));
vi.mock('@/hooks/useReadiness', () => ({ useReadiness: () => ({ data: readiness, isError }) }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
beforeEach(() => {
  admin = true;
  isError = false;
  readiness = incomplete;
  pathname = '/requests';
});
afterEach(cleanup);

describe('global setup indicator', () => {
  it('removes an open checklist when setup finishes or a readiness refresh fails', () => {
    const { rerender } = render(<SetupIndicator />);
    fireEvent.click(screen.getByRole('button', { name: /Setup:/ }));
    isError = true;
    rerender(<SetupIndicator />);
    expect(screen.queryByRole('dialog')).toBeNull();
    isError = false;
    rerender(<SetupIndicator />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Setup:/ }));
    readiness = {
      ...incomplete,
      items: incomplete.items.map((item) => ({ ...item, ok: true })),
      ready: true,
    };
    rerender(<SetupIndicator />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /Setup:/ })).toBeNull();
  });
  it('shows progress only when there is an unfinished step and opens the shared checklist', () => {
    render(<SetupIndicator />);
    const trigger = screen.getByRole('button', { name: 'Setup: 1 of 2 steps complete' });
    expect(trigger.textContent).toContain('1/2');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Setup checklist' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Finish setting up' })).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Fix this: Model provider credentials' })
        .getAttribute('href')
    ).toBe('/models?tab=credentials');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close setup checklist' })
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('link', { name: 'Fix this: Model provider credentials' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('closes via its close button, outside clicks, and route navigation', () => {
    const { rerender } = render(<SetupIndicator />);
    const trigger = screen.getByRole('button', { name: /Setup:/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Close setup checklist' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(trigger);
    pathname = '/agents';
    rerender(<SetupIndicator />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it.each(['complete', 'informational', 'loading', 'error', 'non-admin', 'empty'])(
    'hides for %s',
    (state) => {
      if (state === 'complete' || state === 'informational') {
        readiness = {
          ...incomplete,
          items: incomplete.items.map((item) => ({
            ...item,
            informational: state === 'informational',
            ok: true,
          })),
          ready: true,
        };
      }
      if (state === 'loading') {
        readiness = undefined;
      }
      if (state === 'error') {
        isError = true;
      }
      if (state === 'non-admin') {
        admin = false;
      }
      if (state === 'empty') {
        readiness = { ...incomplete, items: [] };
      }
      const { container } = render(<SetupIndicator />);
      expect(container.innerHTML).toBe('');
    }
  );
});
