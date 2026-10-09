// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
// The repository dialog has its own tests; here it only has to open.
vi.mock('@/components/repositories/RepoAutomationsModal', () => ({
  RepoAutomationsModal: ({ repo }: { repo: { repoName: string } }) => (
    <div>automations of {repo.repoName}</div>
  ),
}));

import GovernAutomationsPage from './page';

const REPO = { id: 'r1', organizationName: 'acme', repoName: 'api', type: 'git_repo' };

const eventRow = {
  canManage: true,
  enabled: true,
  id: 'a1',
  kind: 'event',
  lastActivity: { at: '2026-10-01T00:00:00.000Z', outcome: 'SUPPRESSED_SAME_SUBJECT' },
  name: 'mainline CI',
  repository: { id: 'r1', organizationName: 'acme', repoName: 'api' },
  source: 'github.workflow_run.failed',
  team: { id: 't1', name: 'Payments' },
  template: null,
  when: 'When CI fails: pushes on main · .github/workflows/**',
};

const webhookRow = {
  canManage: false,
  enabled: true,
  id: 'tpl-1',
  kind: 'template_webhook',
  lastActivity: null,
  name: 'deploy hook',
  repository: null,
  team: { id: 't1', name: 'Payments' },
  template: { id: 'tpl-1', name: 'deploy hook' },
  when: 'A POST to the template’s secret webhook URL',
};

const schedule = {
  canManage: false,
  cronExpression: '0 3 * * 1',
  id: 's1',
  isActive: true,
  name: 'Weekly deps',
  repository: { id: 'r1', organizationName: 'acme', repoName: 'api' },
  schedule: { exists: true, lastRunAt: null, nextRunAt: null, paused: true },
  team: { id: 't1', name: 'Payments' },
  template: null,
};

beforeEach(() => {
  stubDialogPrototype();
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'LEAD', sub: 'me' } });
  setupFetchMock({
    'GET /api/v1/automations': () => ({ data: [eventRow, webhookRow] }),
    'GET /api/v1/repositories': () => ({ data: [REPO] }),
    'GET /api/v1/scheduled-work-requests': () => ({ data: [schedule] }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

describe('GovernAutomationsPage', () => {
  it('lists every kind in one table, schedules merged from their own route', async () => {
    render(withQuery(<GovernAutomationsPage />));
    expect(await screen.findByText('mainline CI')).toBeTruthy();
    expect(screen.getByText('deploy hook', { selector: 'div' })).toBeTruthy();
    expect(await screen.findByText('Weekly deps')).toBeTruthy();
    expect(screen.getByText('already handled')).toBeTruthy();
    // A paused schedule reads as off.
    const row = screen.getByText('Weekly deps').closest('tr') as HTMLElement;
    expect(within(row).getByText('off')).toBeTruthy();
  });

  it('opens where each kind is edited, as View when the caller may not manage it', async () => {
    render(withQuery(<GovernAutomationsPage />));
    const hookRow = (await screen.findByText('deploy hook', { selector: 'div' })).closest(
      'tr'
    ) as HTMLElement;
    expect(within(hookRow).getByRole('link', { name: 'View' }).getAttribute('href')).toBe(
      '/workflows/library/tpl-1'
    );
    const eventTr = screen.getByText('mainline CI').closest('tr') as HTMLElement;
    fireEvent.click(within(eventTr).getByRole('button', { name: 'Manage' }));
    expect(await screen.findByText('automations of api')).toBeTruthy();
  });

  it('opens an event automation whose repository is not in the (active, capped) list', async () => {
    setupFetchMock({
      'GET /api/v1/automations': () => ({ data: [eventRow] }),
      'GET /api/v1/repositories': () => ({ data: [] }),
      'GET /api/v1/scheduled-work-requests': () => ({ data: [] }),
    });
    render(withQuery(<GovernAutomationsPage />));
    const eventTr = (await screen.findByText('mainline CI')).closest('tr') as HTMLElement;
    fireEvent.click(within(eventTr).getByRole('button', { name: 'Manage' }));
    expect(await screen.findByText('automations of api')).toBeTruthy();
  });

  it('shows a schedule whose Temporal schedule is gone as off, with its stored last fire', async () => {
    setupFetchMock({
      'GET /api/v1/automations': () => ({ data: [] }),
      'GET /api/v1/repositories': () => ({ data: [REPO] }),
      'GET /api/v1/scheduled-work-requests': () => ({
        data: [
          {
            ...schedule,
            isActive: true,
            lastFiredAt: '2026-10-01T00:00:00.000Z',
            schedule: { exists: false, lastRunAt: null, nextRunAt: null, paused: false },
          },
        ],
      }),
    });
    render(withQuery(<GovernAutomationsPage />));
    const row = (await screen.findByText('Weekly deps')).closest('tr') as HTMLElement;
    expect(within(row).getByText('off')).toBeTruthy();
    expect(within(row).getByText('fired')).toBeTruthy();
  });

  it('filters by kind', async () => {
    render(withQuery(<GovernAutomationsPage />));
    await screen.findByText('Weekly deps');
    fireEvent.click(screen.getByRole('button', { name: /kind/i }));
    fireEvent.click(screen.getByRole('option', { name: 'Schedule' }));
    expect(screen.queryByText('mainline CI')).toBeNull();
    expect(screen.getByText('Weekly deps')).toBeTruthy();
  });
});
