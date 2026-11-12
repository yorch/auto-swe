// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIDEBAR_STORAGE_KEY } from '@/lib/sidebar';
import { useSidebarStore } from '@/stores/sidebarStore';
import { installMemoryStorage } from '@/test/memoryStorage';
import { resetNavigation } from '@/test/mockNavigation';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/hooks/useApprovals', () => ({
  useApprovalsCount: () => 0,
  useApprovalsStream: () => undefined,
}));
vi.mock('@/components/assistant/AssistantPanel', () => ({ AssistantPanel: () => null }));
vi.mock('@/components/layout/Sidebar', () => ({
  Sidebar: ({
    closeButtonRef,
    collapsed,
    onToggle,
  }: {
    closeButtonRef: React.RefObject<HTMLButtonElement | null>;
    collapsed: boolean;
    onToggle: () => void;
  }) => (
    <aside data-collapsed={collapsed}>
      <button ref={closeButtonRef} type="button">
        close
      </button>
      <button onClick={onToggle} type="button">
        toggle sidebar
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

import { AppShell, isFullscreenRoute } from './AppShell';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  installMemoryStorage();
  useSidebarStore.setState({ collapsed: false });
});

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
  it('moves focus to Close navigation after the drawer opens', async () => {
    openDrawer();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'close' }))
    );
  });
  it('uses the same sidebar on workspace routes and makes the page inert while the drawer is open', () => {
    resetNavigation('', '/runs/run-1');
    render(
      <AppShell>
        <p>workspace</p>
      </AppShell>
    );
    expect(screen.queryByRole('navigation', { name: 'Focused navigation' })).toBeNull();
    const content = screen.getByText('workspace').closest('main')?.parentElement;
    expect(content?.hasAttribute('inert')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'menu' }));
    expect(content?.hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(content?.hasAttribute('inert')).toBe(false);
  });
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

describe('desktop sidebar preference', () => {
  it('persists an ordinary-route toggle and restores it on mount', () => {
    resetNavigation('', '/requests');
    const { unmount } = render(
      <AppShell>
        <p>requests</p>
      </AppShell>
    );
    fireEvent.click(screen.getByRole('button', { name: 'toggle sidebar' }));
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('collapsed');
    expect(document.querySelector('aside')?.getAttribute('data-collapsed')).toBe('true');
    unmount();
    useSidebarStore.setState({ collapsed: false });
    render(
      <AppShell>
        <p>requests</p>
      </AppShell>
    );
    expect(document.querySelector('aside')?.getAttribute('data-collapsed')).toBe('true');
  });

  it.each(['expanded', 'collapsed'])(
    'focused visits ignore and preserve the %s preference',
    (saved) => {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, saved);
      resetNavigation('', '/library/t1');
      const { rerender } = render(
        <AppShell>
          <p>editor</p>
        </AppShell>
      );
      expect(document.querySelector('aside')?.getAttribute('data-collapsed')).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'toggle sidebar' }));
      expect(document.querySelector('[data-sidebar-shell]')?.getAttribute('data-focused')).toBe(
        'expanded'
      );
      expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe(saved);
      resetNavigation('', '/runs/r1');
      rerender(
        <AppShell>
          <p>run</p>
        </AppShell>
      );
      expect(document.querySelector('aside')?.getAttribute('data-collapsed')).toBe('true');
      resetNavigation('', '/requests');
      rerender(
        <AppShell>
          <p>requests</p>
        </AppShell>
      );
      expect(document.querySelector('aside')?.getAttribute('data-collapsed')).toBe(
        String(saved === 'collapsed')
      );
      expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe(saved);
    }
  );
});

describe('isFullscreenRoute', () => {
  it.each(['/runs/abc', '/library/t1/diff', '/library/t1', '/library/t1/'])(
    'gives %s the whole main area',
    (path) => {
      expect(isFullscreenRoute(path)).toBe(true);
    }
  );

  it.each(['/library', '/library/t1/analytics', '/library/t1/runs', '/runs'])(
    'leaves %s as an ordinary scrolling page',
    (path) => {
      expect(isFullscreenRoute(path)).toBe(false);
    }
  );
});
