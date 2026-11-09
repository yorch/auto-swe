// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nav, resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import TeamByIdPage from './page';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));

const TEAM_ID = '11111111-1111-4111-8111-111111111111';

function resolvedParams<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value });
}

const teams = (list: { id: string; slug: string }[]) => () => ({
  data: list.map((t) => ({ ...t, myRole: 'LEAD', name: t.slug, orgName: 'Acme' })),
});

beforeEach(() => resetNavigation('', `/admin/teams/${TEAM_ID}`));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage(id = TEAM_ID) {
  render(withQuery(<TeamByIdPage params={resolvedParams({ id })} />));
}

describe('/admin/teams/[id] redirect', () => {
  it('replaces itself with the team’s space, keyed by slug', async () => {
    setupFetchMock({ '/api/v1/teams': teams([{ id: TEAM_ID, slug: 'payments' }]) });
    renderPage();
    await waitFor(() => expect(nav.replace).toEqual(['/teams/payments']));
  });

  it('sends a settings section to the team’s Settings tab with the section kept', async () => {
    resetNavigation('tab=sandbox', `/admin/teams/${TEAM_ID}`);
    setupFetchMock({ '/api/v1/teams': teams([{ id: TEAM_ID, slug: 'payments' }]) });
    renderPage();
    await waitFor(() => expect(nav.replace).toEqual(['/teams/payments/settings?tab=sandbox']));
  });

  it('resolves a deactivated team, which the active list lacks, through its own record', async () => {
    setupFetchMock({
      '/api/v1/teams': teams([{ id: 'other', slug: 'other' }]),
      [`/api/v1/teams/${TEAM_ID}`]: () => ({ data: { id: TEAM_ID, slug: 'retired' } }),
    });
    renderPage();
    await waitFor(() => expect(nav.replace).toEqual(['/teams/retired']));
  });

  it('shows not-found, and goes nowhere, for an id neither the list nor the gateway knows', async () => {
    const listBody = JSON.stringify(teams([{ id: 'other', slug: 'other' }])());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0];
        return path === '/api/v1/teams'
          ? new Response(listBody, { headers: { 'content-type': 'application/json' }, status: 200 })
          : new Response(
              JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Team not found' } }),
              {
                headers: { 'content-type': 'application/json' },
                status: 404,
              }
            );
      })
    );
    renderPage();
    expect(await screen.findByText('Team not found')).toBeTruthy();
    expect(nav.replace).toEqual([]);
  });

  it('shows not-found for an unusable id without asking the gateway', async () => {
    const spy = setupFetchMock({ '/api/v1/teams': teams([]) });
    renderPage('   ');
    expect(await screen.findByText('Team not found')).toBeTruthy();
    expect(nav.replace).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
