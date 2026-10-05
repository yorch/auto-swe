// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nav, resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

import AutonomyDecisionsPage from './page';

beforeEach(() => resetNavigation('', '/govern/policies/decisions'));
afterEach(() => vi.unstubAllGlobals());

function mock() {
  return setupFetchMock({
    '/api/v1/platform/autonomy-decisions': () => ({
      data: Array.from({ length: 50 }, (_, i) => ({
        actorId: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        event: 'run.start',
        id: `d${i}`,
        policyName: 'p',
        riskClass: 'LOW',
        runId: 'aaaaaaaa-1111-4111-8111-111111111111',
      })),
      meta: { limit: 50, offset: 0, total: 120 },
    }),
    '/api/v1/platform/autonomy-policies': () => ({ data: [] }),
    '/api/v1/users': () => ({ data: [] }),
  });
}

describe('AutonomyDecisionsPage URL state', () => {
  it('pages through useUrlFilters, writing the offset into the URL', async () => {
    mock();
    render(withQuery(<AutonomyDecisionsPage />));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next page' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(nav.replace.at(-1)).toBe('/govern/policies/decisions?offset=50');
  });
});
