// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flattenNavItems, NAV_ITEMS, visibleNavGroups } from '@/lib/navigation';
import { useAuthStore } from '@/stores/authStore';
import { installMemoryStorage } from '@/test/memoryStorage';
import { GOVERNANCE_GROUPS, GovernanceGuide } from './GovernanceGuide';

let isAdmin = true;
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => isAdmin }));
let readiness: { data?: { ready: boolean } } = { data: { ready: true } };
vi.mock('@/hooks/useReadiness', () => ({ useReadiness: () => readiness }));

beforeEach(() => {
  isAdmin = true;
  readiness = { data: { ready: true } };
  installMemoryStorage();
  useAuthStore.setState({ user: { role: 'ADMIN', sub: 'a1' } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.setState({ user: null });
});

describe('GovernanceGuide', () => {
  it('states only what the code does: auto-approval is org-scoped and nothing needs a restart', () => {
    render(<GovernanceGuide />);
    expect(screen.getByText(/organization on the auto-approve list/)).toBeTruthy();
    expect(screen.queryByText(/restart/i)).toBeNull();
  });

  it('moves focus to the main region when dismissed', () => {
    render(
      <main id="main-content" tabIndex={-1}>
        <GovernanceGuide />
      </main>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the governance guide' }));
    expect(document.activeElement?.id).toBe('main-content');
  });

  it('lists the six groups in order, each link with a reason', () => {
    render(<GovernanceGuide />);
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent?.replace(/^\d/, ''))
    ).toEqual([
      'Who and what',
      'Control the agents',
      'Guardrails',
      'Configuration',
      'Cost and ROI',
      'Automation and quality',
    ]);
    expect(screen.getAllByRole('link')).toHaveLength(13);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText(/not a checklist/)).toBeTruthy();
  });

  it('only links real pages an admin can open, labelled as the nav labels them', () => {
    const visible = new Set(
      visibleNavGroups('ADMIN').flatMap((g) => flattenNavItems(g.items).map((i) => i.href))
    );
    for (const link of GOVERNANCE_GROUPS.flatMap((g) => g.links)) {
      expect(visible.has(link.href), link.href).toBe(true);
      expect(NAV_ITEMS.find((i) => i.href === link.href)?.label).toBe(link.label);
      expect(link.reason.length).toBeGreaterThan(10);
    }
  });

  it('waits for the setup card to be complete', () => {
    readiness = { data: { ready: false } };
    render(<GovernanceGuide />);
    expect(screen.queryByTestId('governance-guide')).toBeNull();
    cleanup();
    readiness = {};
    render(<GovernanceGuide />);
    expect(screen.queryByTestId('governance-guide')).toBeNull();
  });

  it('renders nothing for a non-admin', () => {
    isAdmin = false;
    render(<GovernanceGuide />);
    expect(screen.queryByTestId('governance-guide')).toBeNull();
  });

  it('dismisses and stays dismissed for that admin only', () => {
    const { unmount } = render(<GovernanceGuide />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the governance guide' }));
    expect(screen.queryByTestId('governance-guide')).toBeNull();
    expect(localStorage.getItem('auto-swe.dismissed.a1.governance-guide')).toBe('1');
    unmount();
    render(<GovernanceGuide />);
    expect(screen.queryByTestId('governance-guide')).toBeNull();
    cleanup();
    useAuthStore.setState({ user: { role: 'ADMIN', sub: 'a2' } });
    render(<GovernanceGuide />);
    expect(screen.getByTestId('governance-guide')).toBeTruthy();
  });

  it('renders and dismisses for the page view when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<GovernanceGuide />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the governance guide' }));
    expect(screen.queryByTestId('governance-guide')).toBeNull();
  });
});
