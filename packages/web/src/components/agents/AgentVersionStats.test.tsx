// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { AgentVersionStats } from './AgentVersionStats';

const PATH = 'GET /api/v1/platform/agent-library/a1/version-stats';

function stats(over: Record<string, unknown> = {}) {
  return {
    data: {
      groupsTruncated: false,
      isTruncated: false,
      key: 'reviewer',
      rows: [
        {
          agentId: 'a2',
          agentVersion: 2,
          avgDurationMs: 1500,
          calls: 120,
          costUsd: 3.5,
          distinctRuns: 40,
          errors: 6,
          inputTokens: 2_000_000,
          model: 'anthropic/claude-x',
          outputTokens: 50_000,
          scope: 'GLOBAL',
        },
        {
          agentId: 'a1',
          agentVersion: 1,
          avgDurationMs: null,
          calls: 8,
          costUsd: 0.2,
          distinctRuns: 3,
          errors: 0,
          inputTokens: 1000,
          model: 'anthropic/claude-y',
          outputTokens: 100,
          scope: 'GLOBAL',
        },
      ],
      runsTruncated: false,
      scope: 'GLOBAL',
      since: '2026-09-22',
      unrecorded: [
        {
          agentId: null,
          agentVersion: null,
          avgDurationMs: 900,
          calls: 77,
          costUsd: 1,
          distinctRuns: 12,
          errors: 1,
          inputTokens: 5000,
          model: 'anthropic/claude-old',
          outputTokens: 500,
          scope: null,
        },
      ],
      until: '2026-10-21',
      windowDays: 30,
      ...over,
    },
  };
}

beforeEach(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

describe('AgentVersionStats', () => {
  it('shows a row per version and model, an unrecorded row, and the disclosure', async () => {
    setupFetchMock({ [PATH]: () => stats() });
    render(withQuery(<AgentVersionStats agentId="a1" />));
    expect(await screen.findByText('v2')).toBeTruthy();
    expect(screen.getByText('v1')).toBeTruthy();
    expect(screen.getByText('anthropic/claude-x')).toBeTruthy();
    expect(screen.getByText('anthropic/claude-y')).toBeTruthy();
    expect(screen.getByText('Unrecorded')).toBeTruthy();
    expect(screen.getByText('anthropic/claude-old')).toBeTruthy();
    // Sample sizes are shown, not only rates.
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.getByText('40')).toBeTruthy();
    expect(screen.getByText(/not a controlled comparison/)).toBeTruthy();
    expect(screen.getByText(/Per version and model, across every run that used it/)).toBeTruthy();
    expect(screen.getByText(/Unrecorded: calls with no recorded agent version/)).toBeTruthy();
  });

  it('says so when the window holds no calls', async () => {
    setupFetchMock({ [PATH]: () => stats({ rows: [], unrecorded: [] }) });
    render(withQuery(<AgentVersionStats agentId="a1" />));
    expect(await screen.findByText(/No recorded LLM calls for this agent/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows an error with a retry rather than an empty table', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 }))
    );
    render(withQuery(<AgentVersionStats agentId="a1" />));
    expect(await screen.findByText(/Could not load version stats/)).toBeTruthy();
    expect(screen.queryByText(/No recorded LLM calls/)).toBeNull();
  });

  it('says rows are missing when the group list was cut', async () => {
    setupFetchMock({
      [PATH]: () => stats({ groupsTruncated: true, isTruncated: true, runsTruncated: true }),
    });
    render(withQuery(<AgentVersionStats agentId="a1" />));
    expect(
      await screen.findByText(/some rows are missing and the figures are partial/)
    ).toBeTruthy();
    expect(screen.getByText(/run counts are lower bounds/)).toBeTruthy();
  });

  it('keeps calls and cost unqualified when only the run counts were cut', async () => {
    setupFetchMock({
      [PATH]: () => stats({ groupsTruncated: false, isTruncated: true, runsTruncated: true }),
    });
    render(withQuery(<AgentVersionStats agentId="a1" />));
    expect(await screen.findByText(/Calls, errors, tokens and cost are complete/)).toBeTruthy();
    expect(screen.queryByText(/figures are partial/)).toBeNull();
  });

  it('asks for the last 30 days, then for another window when one is picked', async () => {
    const spy = setupFetchMock({ [PATH]: () => stats() });
    render(withQuery(<AgentVersionStats agentId="a1" />));
    await screen.findByText('v2');
    expect(String(spy.mock.calls[0]?.[0])).toContain('window=30');
    fireEvent.click(screen.getByRole('button', { name: /Window/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(spy.mock.calls.some(([u]) => String(u).includes('window=7'))).toBe(true)
    );
  });
});
