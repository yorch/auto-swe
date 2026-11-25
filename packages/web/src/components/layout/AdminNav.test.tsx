// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetNavigation } from '@/test/mockNavigation';
import {
  ADMIN_PERMISSIONS,
  NO_PERMISSIONS,
  permissionsFor,
  resetPermissions,
  setPermissions,
} from '@/test/permissions';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/hooks/useEffectivePermissions', async () =>
  (await import('@/test/permissions')).permissionsMock()
);
vi.mock('@/hooks/useAdmin', () => ({
  useUsageScopes: () => ({ data: { orgs: [], platform: false, teams: [] } }),
}));

import { AdminNav } from './AdminNav';

const PEOPLE = {
  admin: ADMIN_PERMISSIONS,
  // A plain team member a configuration grant covers: the server says they may write a setting.
  grantHolder: permissionsFor({
    canWriteAnySetting: true,
    teams: [{ capabilities: ['team.read'], role: 'MEMBER', teamId: 't1' }],
  }),
  lead: permissionsFor({
    orgs: [{ capabilities: ['org.baselines.read'], orgId: 'o1' }],
    teams: [{ capabilities: ['team.settings.manage'], role: 'LEAD', teamId: 't1' }],
  }),
  member: NO_PERMISSIONS,
} as const;
const useWho = (who: keyof typeof PEOPLE) => setPermissions(PEOPLE[who]);

afterEach(() => {
  cleanup();
  resetPermissions();
});

function links() {
  const nav = screen.getByRole('navigation', { name: 'Admin' });
  return within(nav)
    .getAllByRole('link', { hidden: true })
    .map((a) => a.getAttribute('href'));
}

describe('AdminNav', () => {
  it('lists every Admin page for a platform admin, by section', () => {
    useWho('admin');
    resetNavigation('', '/admin/users');
    render(<AdminNav />);
    expect(links()).toEqual(expect.arrayContaining(['/admin', '/admin/users', '/admin/scanner']));
    for (const section of ['Access', 'Security', 'Configuration', 'Credentials', 'Quality']) {
      expect(screen.getByRole('list', { hidden: true, name: section })).toBeTruthy();
    }
  });

  it('keeps the gating of the sidebar: a member sees only the pages open to everyone', () => {
    useWho('member');
    resetNavigation('', '/admin/organizations');
    render(<AdminNav />);
    const hrefs = links();
    expect(hrefs).toContain('/admin/organizations');
    expect(hrefs).toContain('/admin/slack-channels');
    // Teams and Automations left Admin for the Teams and insights group.
    expect(hrefs).not.toContain('/admin/teams');
    expect(hrefs).not.toContain('/automations');
    expect(hrefs).not.toContain('/admin/users');
    expect(hrefs).not.toContain('/admin/platform-settings');
    expect(hrefs).not.toContain('/insights/usage');
    expect(screen.queryByRole('list', { hidden: true, name: 'Security' })).toBeNull();
  });

  it('adds the pages a team lead’s capabilities open, and still no platform admin page', () => {
    useWho('lead');
    resetNavigation('', '/admin/organizations');
    render(<AdminNav />);
    const hrefs = links();
    // Platform settings follows the server's `canWriteAnySetting`, which a lead without a grant lacks.
    expect(hrefs).not.toContain('/admin/platform-settings');
    expect(hrefs).toContain('/admin/baselines');
    expect(hrefs).not.toContain('/admin/users');
    expect(hrefs).not.toContain('/admin/scanner');
  });

  it('offers Platform settings to a grant holder who leads nothing', () => {
    useWho('grantHolder');
    resetNavigation('', '/admin/organizations');
    render(<AdminNav />);
    expect(links()).toContain('/admin/platform-settings');
  });

  it('marks the current page, and the parent entry on a page without its own', () => {
    useWho('admin');
    resetNavigation('', '/admin/organizations/abc');
    render(<AdminNav />);
    const current = screen
      .getAllByRole('link', { hidden: true })
      .filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['/admin/organizations']);
  });

  it('folds into a disclosure naming the current page on narrow screens', () => {
    useWho('admin');
    resetNavigation('', '/admin/audit');
    render(<AdminNav />);
    const toggle = screen.getByRole('button', { name: /Admin.*Audit log/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(toggle.getAttribute('aria-controls') as string);
    expect(panel?.className).toContain('max-lg:hidden');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel?.className).not.toContain('max-lg:hidden');
  });
});
