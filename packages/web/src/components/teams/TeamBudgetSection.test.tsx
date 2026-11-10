// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { TeamBudgetSection } from './TeamBudgetSection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const T = 'team-1';
const status = (scope: 'org' | 'team') => ({
  data: { alertThresholdPercent: 80, percentUsed: 42, scope, state: 'ok' },
});
const settings = (cap: number | null, threshold: number | null = null) => ({
  data: {
    budgetAlertThresholdPercent: threshold,
    monthlyBudgetUsdCents: cap,
    monthSpendUsdCents: 12345,
  },
});

function mock(cap: number | null, threshold: number | null = null, patch?: () => unknown) {
  return setupFetchMock({
    [`GET /api/v1/teams/${T}/budget`]: () => settings(cap, threshold),
    [`GET /api/v1/teams/${T}/budget/status`]: () => status(cap === null ? 'org' : 'team'),
    [`PATCH /api/v1/teams/${T}/budget`]: patch ?? (() => settings(cap, threshold)),
  });
}

function renderSection(canManageCredentials = false) {
  render(withQuery(<TeamBudgetSection canManageCredentials={canManageCredentials} teamId={T} />));
}

describe('TeamBudgetSection', () => {
  it('shows the month spend against the cap with the team meter, and prefills dollars', async () => {
    mock(50000, 75);
    renderSection();
    expect((await screen.findByTestId('spend')).textContent).toContain('$123.45');
    expect(screen.getByTestId('spend').textContent).toContain('of $500.00 this month');
    expect((await screen.findByTestId('budget-meter')).textContent).toContain('team budget');
    expect((screen.getByLabelText(/Monthly cap/) as HTMLInputElement).value).toBe('500');
    expect((screen.getByLabelText(/Alert threshold/) as HTMLInputElement).value).toBe('75');
  });

  it('explains how the caps combine and who is billed for shared repositories', async () => {
    mock(null);
    renderSection();
    expect(await screen.findByText(/in addition to the organization’s/)).toBeTruthy();
    expect(screen.getByText(/tighter one/)).toBeTruthy();
    expect(screen.getByText(/billed to the team that owns the repository/)).toBeTruthy();
  });

  it('converts dollars to cents on save', async () => {
    const spy = mock(null);
    renderSection();
    fireEvent.change(await screen.findByLabelText(/Monthly cap/), { target: { value: '250.50' } });
    fireEvent.change(screen.getByLabelText(/Alert threshold/), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await waitFor(() =>
      expect(bodyOf(spy, `/api/v1/teams/${T}/budget`, 'PATCH')).toEqual({
        budgetAlertThresholdPercent: 90,
        monthlyBudgetUsdCents: 25050,
      })
    );
    expect(await screen.findByText('Budget saved.')).toBeTruthy();
  });

  it('refuses a negative cap and a bad threshold without calling the server', async () => {
    const spy = mock(null);
    renderSection();
    fireEvent.change(await screen.findByLabelText(/Monthly cap/), { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(await screen.findByText('The monthly cap cannot be negative.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Monthly cap/), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText(/Alert threshold/), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(await screen.findByText(/whole number from 1 to 100/)).toBeTruthy();
    expect(spy.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PATCH')).toBe(
      false
    );
  });

  it('keeps Save disabled until something changes', async () => {
    mock(50000);
    renderSection();
    const save = (await screen.findByRole('button', { name: 'Save budget' })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Monthly cap/), { target: { value: '600' } });
    expect(save.disabled).toBe(false);
  });

  it('clears the cap and the threshold with null', async () => {
    const spy = mock(50000, 75);
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear team cap' }));
    await waitFor(() =>
      expect(bodyOf(spy, `/api/v1/teams/${T}/budget`, 'PATCH')).toEqual({
        budgetAlertThresholdPercent: null,
        monthlyBudgetUsdCents: null,
      })
    );
    expect((screen.getByLabelText(/Monthly cap/) as HTMLInputElement).value).toBe('');
  });

  it('offers no Clear button when the team sets no cap', async () => {
    mock(null);
    renderSection();
    await screen.findByLabelText(/Monthly cap/);
    expect(screen.queryByRole('button', { name: 'Clear team cap' })).toBeNull();
  });

  it('shows a server refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const body =
          method === 'PATCH'
            ? { error: { code: 'FORBIDDEN', message: 'Not allowed to set this' } }
            : String(input).endsWith('/status')
              ? status('org')
              : settings(null);
        return new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
          status: method === 'PATCH' ? 403 : 200,
        });
      })
    );
    renderSection();
    fireEvent.change(await screen.findByLabelText(/Monthly cap/), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(await screen.findByText(/Not allowed to set this/)).toBeTruthy();
  });

  it('links to Model configuration only when the caller can reach it', async () => {
    mock(null);
    renderSection(false);
    await screen.findByLabelText(/Monthly cap/);
    expect(screen.queryByRole('link', { name: 'Model configuration' })).toBeNull();
    cleanup();
    mock(null);
    renderSection(true);
    const link = await screen.findByRole('link', { name: 'Model configuration' });
    expect(link.getAttribute('href')).toBe('/models');
  });
});
