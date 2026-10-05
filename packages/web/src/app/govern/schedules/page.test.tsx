// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import GovernSchedulesPage from './page';

const schedule = (over: Record<string, unknown> = {}) => ({
  actsAs: { email: 'me@x.com', id: 'me', name: 'Me' },
  budgetTier: 'STANDARD',
  canManage: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  createdBy: null,
  cronExpression: '0 3 * * 1',
  description: 'Update deps',
  externalTicketId: 'DEPS-SCHED-abc',
  externalTicketPrefix: 'DEPS',
  id: 's1',
  isActive: true,
  lastFiredAt: null,
  name: 'Weekly deps',
  repository: { id: 'r1', organizationName: 'acme', repoName: 'api' },
  schedule: { exists: true, lastRunAt: null, nextRunAt: null, paused: false },
  team: { id: 't1', name: 'Payments', slug: 'payments' },
  template: null,
  templateVersion: null,
  updatedAt: '2026-09-01T00:00:00.000Z',
  workRequestId: 'w1',
  ...over,
});

function mock(rows: unknown[]) {
  return setupFetchMock({
    'GET /api/v1/repositories': () => ({ data: [] }),
    'GET /api/v1/scheduled-work-requests': () => ({ data: rows }),
    'GET /api/v1/templates': () => ({ data: [] }),
    'GET /api/v1/workflow-templates': () => ({ data: [] }),
    'PATCH /api/v1/scheduled-work-requests/s1': () => ({ data: schedule() }),
  });
}

beforeEach(() => {
  stubDialogPrototype();
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'ADMIN', sub: 'me' } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

describe('GovernSchedulesPage', () => {
  it('disables Fire now from the live state, not the recorded flag', async () => {
    mock([
      schedule({
        isActive: true,
        schedule: { exists: true, lastRunAt: null, nextRunAt: null, paused: true },
      }),
    ]);
    render(withQuery(<GovernSchedulesPage />));
    const fire = (await screen.findByRole('button', { name: 'Fire now' })) as HTMLButtonElement;
    expect(fire.disabled).toBe(true);
  });

  it('shows a repair hint instead of internal wording when the trigger is missing', async () => {
    mock([
      schedule({ schedule: { exists: false, lastRunAt: null, nextRunAt: null, paused: false } }),
    ]);
    render(withQuery(<GovernSchedulesPage />));
    expect(await screen.findByText('Not running — re-save to repair')).toBeTruthy();
  });

  it('offers no actions on a schedule the caller cannot manage, and says why', async () => {
    mock([schedule({ canManage: false })]);
    render(withQuery(<GovernSchedulesPage />));
    expect(await screen.findByText('Team leads manage this schedule')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fire now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('edits a schedule through PATCH', async () => {
    const spy = mock([schedule()]);
    render(withQuery(<GovernSchedulesPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit schedule' }));
    const name = dialog.getByLabelText(/^name/i) as HTMLInputElement;
    expect(name.value).toBe('Weekly deps');
    fireEvent.change(name, { target: { value: 'Monthly deps' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(bodyOf(spy, '/scheduled-work-requests/s1', 'PATCH')).toMatchObject({
        cronExpression: '0 3 * * 1',
        name: 'Monthly deps',
        templateId: null,
      })
    );
  });
});
