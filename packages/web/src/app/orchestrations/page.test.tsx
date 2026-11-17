// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const offsets = vi.hoisted(() => [] as number[]);
vi.mock('@/hooks/useOrchestrations', () => ({
  ORCHESTRATIONS_PAGE_SIZE: 25,
  useOrchestrations: (offset: number) => {
    offsets.push(offset);
    return { ...state.query, refetch: vi.fn() };
  },
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
    state.query = {
      data: { rows: [], total: 0 },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    };
    render(withQuery(<OrchestrationsPage />));
    expect(screen.getByText('No orchestrations yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Orchestrate' }).getAttribute('href')).toBe(
      '/start?mode=orchestrate'
    );
  });

  it('lists status, team, repository, agents, spend and links to the detail page', () => {
    const { children: _c, ...base } = detail();
    state.query = {
      data: {
        rows: [
          { ...base, repoId: 'r1', repoName: 'acme/api', title: 'Fix <b>checkout</b>' },
          { ...base, id: 'o2', status: 'COMPLETED', teamName: null, title: 'Second' },
        ],
        total: 2,
      },
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

  it('names the team from the summary, then the team list, then a generic word', () => {
    const { children: _c, ...base } = detail();
    state.query = {
      data: {
        rows: [
          { ...base, id: 'a', teamName: 'From summary', title: 'A' },
          { ...base, id: 'b', teamId: 't1', teamName: null, title: 'B' },
          { ...base, id: 'c', teamId: 'other', teamName: null, title: 'C' },
        ],
        total: 3,
      },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    };
    render(withQuery(<OrchestrationsPage />));
    expect(screen.getAllByText('From summary').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Payments').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Team').length).toBeGreaterThan(0);
  });

  it('pages through every orchestration using the total', () => {
    const { children: _c, ...base } = detail();
    offsets.length = 0;
    state.query = {
      data: { rows: [{ ...base, title: 'Only the first page' }], total: 60 },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    };
    render(withQuery(<OrchestrationsPage />));
    expect(screen.getByText('1–1 of 60')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(offsets.at(-1)).toBe(25);
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(offsets.at(-1)).toBe(0);
  });
});
