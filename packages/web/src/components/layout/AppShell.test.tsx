// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetNavigation } from '@/test/mockNavigation';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/hooks/useApprovals', () => ({
  useApprovalsCount: () => 0,
  useApprovalsStream: () => undefined,
}));
vi.mock('@/hooks/useDocumentTitle', () => ({ useRouteDocumentTitle: () => undefined }));
vi.mock('@/components/layout/Sidebar', () => ({
  Sidebar: ({ closeButtonRef }: { closeButtonRef: React.RefObject<HTMLButtonElement | null> }) => (
    <aside>
      <button ref={closeButtonRef} type="button">
        close
      </button>
      <a href="/x">last</a>
    </aside>
  ),
}));
vi.mock('@/components/layout/TopBar', () => ({
  TopBar: ({ onOpenNav }: { onOpenNav: () => void }) => (
    <button onClick={onOpenNav} type="button">
      menu
    </button>
  ),
}));

import { AppShell } from './AppShell';

afterEach(cleanup);

function openDrawer() {
  resetNavigation('', '/');
  render(
    <AppShell>
      <p>page</p>
    </AppShell>
  );
  fireEvent.click(screen.getByRole('button', { name: 'menu' }));
}

describe('AppShell mobile drawer focus trap', () => {
  it('pulls Tab from outside the drawer back into it', () => {
    openDrawer();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'close' }));
    outside.remove();
  });

  it('leaves Tab alone while focus is inside the product tour card', () => {
    openDrawer();
    const card = document.createElement('div');
    card.setAttribute('data-tour-card', '');
    const next = document.createElement('button');
    card.appendChild(next);
    document.body.appendChild(card);
    next.focus();
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Tab' });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(next);
    card.remove();
  });

  it('marks its Escape as handled, so the tour does not also end on it', () => {
    openDrawer();
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
