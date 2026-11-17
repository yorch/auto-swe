// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detail } from '@/test/orchestrationFixtures';
import { withQuery } from '@/test/rtl-helpers';

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
const state = vi.hoisted(() => ({
  query: {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
  } as Record<string, unknown>,
}));
vi.mock('@/hooks/useOrchestrations', () => ({
  useOrchestrations: () => ({ ...state.query, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useTeams', () => ({
  useTeams: () => ({ data: [{ id: 't1', name: 'Payments' }] }),
}));

import OrchestrationsPage from './page';

afterEach(cleanup);

describe('OrchestrationsPage', () => {
  it('shows a skeleton while loading', () => {
    state.query = { ...state.query, isLoading: true };
    render(withQuery(<OrchestrationsPage />));
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('shows the error with a retry', () => {
    state.query = {
      data: undefined,
      error: new Error('down'),
      isError: true,
      isFetching: false,
      isLoading: false,
    };
    render(withQuery(<OrchestrationsPage />));
    expect(screen.getByText(/Could not load orchestrations: down/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('invites the first orchestration when there are none', () => {
    state.query = { data: [], error: null, isError: false, isFetching: false, isLoading: false };
    render(withQuery(<OrchestrationsPage />));
    expect(screen.getByText('No orchestrations yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Orchestrate' }).getAttribute('href')).toBe(
      '/start?mode=orchestrate'
    );
  });

  it('lists status, team, repository, agents, spend and links to the detail page', () => {
    const { children: _c, ...base } = detail();
    state.query = {
      data: [
        { ...base, repoId: 'r1', repoName: 'acme/api', title: 'Fix <b>checkout</b>' },
        { ...base, id: 'o2', status: 'COMPLETED', title: 'Second' },
      ],
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    };
    render(withQuery(<OrchestrationsPage />));
    expect(screen.getAllByText('Fix <b>checkout</b>').length).toBeGreaterThan(0);
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getAllByText('acme/api').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No repository').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Payments').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 agent/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/completed/).length).toBeGreaterThan(0);
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/orchestrations/o1');
  });
});
