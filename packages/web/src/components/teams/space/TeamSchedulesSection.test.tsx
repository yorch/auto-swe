// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { TeamSchedulesSection } from './TeamSchedulesSection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const schedule = (over: Record<string, unknown> = {}) => ({
  canManage: true,
  cronExpression: '0 3 * * 1',
  id: 's1',
  isActive: true,
  lastDecision: { at: '2026-11-10T03:00:00.000Z', outcome: 'STARTED', reason: null },
  lastFiredAt: null,
  name: 'Weekly dependency update',
  schedule: { exists: true, lastRunAt: null, nextRunAt: null, paused: false },
  ...over,
});

describe('TeamSchedulesSection', () => {
  it('lists the team’s own schedules with cadence, state and last outcome, and opens the editor', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/scheduled-work-requests': () => ({
        data: [
          schedule(),
          schedule({ id: 's2', isActive: false, lastDecision: null, name: 'Nightly audit' }),
        ],
      }),
    });
    render(withQuery(<TeamSchedulesSection team={{ id: 'team-1', slug: 'payments' }} />));
    expect(await screen.findByText('Weekly dependency update')).toBeTruthy();
    expect(screen.getAllByText('0 3 * * 1')).toHaveLength(2);
    expect(screen.getByText('Nightly audit')).toBeTruthy();
    expect(screen.getByText('Enabled')).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByText('started')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open schedules' }).getAttribute('href')).toBe(
      '/admin/schedules'
    );
    expect(String(spy.mock.calls[0]?.[0])).toContain('teamId=team-1');
  });

  it('says so when the team has no schedules, and still links to the editor', async () => {
    setupFetchMock({ 'GET /api/v1/scheduled-work-requests': () => ({ data: [] }) });
    render(withQuery(<TeamSchedulesSection team={{ id: 'team-1', slug: 'payments' }} />));
    expect(await screen.findByText('No schedules yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open schedules' })).toBeTruthy();
  });
});
