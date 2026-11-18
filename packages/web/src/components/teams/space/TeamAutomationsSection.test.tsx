// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { TeamAutomationsSection } from './TeamAutomationsSection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (over: Record<string, unknown>) => ({
  canManage: true,
  enabled: true,
  id: 'a1',
  kind: 'event',
  lastActivity: null,
  name: 'CI failure fixer',
  repository: null,
  team: null,
  template: null,
  when: 'When a workflow run fails',
  ...over,
});

const TEAM_ID = '11111111-1111-4111-8111-111111111111';

function gateway(rows: ReturnType<typeof row>[]) {
  setupFetchMock({
    'GET /api/v1/automations': () => ({ data: rows }),
    [`GET /api/v1/teams/${TEAM_ID}`]: () => ({
      data: {
        id: TEAM_ID,
        repositories: [{ id: 'repo-1', isActive: true, organizationName: 'acme', repoName: 'api' }],
        sharedRepositories: [],
      },
    }),
  });
}

describe('TeamAutomationsSection', () => {
  it('lists the team’s own automations, on its team or its repositories, and not another team’s', async () => {
    gateway([
      row({
        lastActivity: { at: '2026-11-10T03:00:00.000Z', outcome: 'STARTED' },
        team: { id: TEAM_ID, name: 'Payments' },
      }),
      row({
        id: 'a2',
        name: 'Repo automation',
        repository: { id: 'repo-1', organizationName: 'acme', repoName: 'api' },
      }),
      row({ id: 'a3', name: 'Someone else', team: { id: 'other', name: 'Other' } }),
      row({ id: 'a4', kind: 'schedule', name: 'A schedule', team: { id: TEAM_ID, name: 'P' } }),
    ]);
    render(withQuery(<TeamAutomationsSection team={{ id: TEAM_ID, slug: 'payments' }} />));
    expect(await screen.findByText('CI failure fixer')).toBeTruthy();
    expect(screen.getByText('Repo automation')).toBeTruthy();
    expect(screen.queryByText('Someone else')).toBeNull();
    // Schedules have their own section.
    expect(screen.queryByText('A schedule')).toBeNull();
    expect(screen.getAllByText('When a workflow run fails')).toHaveLength(2);
    expect(screen.getByText('started')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
      '/automations?team=payments'
    );
  });

  it('says so when the team has no automations', async () => {
    gateway([]);
    render(withQuery(<TeamAutomationsSection team={{ id: TEAM_ID, slug: 'payments' }} />));
    expect(await screen.findByText('No automations yet')).toBeTruthy();
  });
});
