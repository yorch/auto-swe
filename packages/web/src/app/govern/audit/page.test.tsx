// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import GovernAuditPage from './page';

afterEach(() => vi.unstubAllGlobals());

const ACTOR = '11111111-1111-4111-8111-111111111111';

function row(i: number, actor: { email: string; name: string | null } | null) {
  return {
    action: 'UPDATE',
    actor,
    actorId: actor ? ACTOR : null,
    afterJson: { role: 'ADMIN' },
    beforeJson: { role: 'ENGINEER' },
    createdAt: '2026-09-01T00:00:00.000Z',
    entityId: `e${i}-0000-0000`,
    entityType: 'User',
    id: `row-${i}`,
  };
}

function mockLog(total: number) {
  return setupFetchMock({
    'GET /api/v1/platform/audit-log': () => ({
      data: [row(1, { email: 'alice@example.com', name: 'Alice' }), row(2, null)],
      meta: { entityTypes: ['Agent', 'User'], limit: 50, offset: 0, total },
    }),
  });
}

const urls = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map(([u]) => String(u));

describe('GovernAuditPage', () => {
  it('shows the actor by email with the id on hover, and system writes as system', async () => {
    mockLog(2);
    render(withQuery(<GovernAuditPage />));

    const actor = await screen.findByRole('button', { name: 'alice@example.com' });
    expect(actor.getAttribute('title')).toContain(ACTOR);
    expect(screen.getByText('system')).toBeTruthy();
  });

  it('pages through the log with the shared pagination control', async () => {
    const spy = mockLog(120);
    render(withQuery(<GovernAuditPage />));
    await screen.findByText('1–50 of 120');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => expect(urls(spy).some((u) => u.includes('offset=50'))).toBe(true));
  });

  it('narrows to one actor when the actor is clicked, and clears back', async () => {
    const spy = mockLog(2);
    render(withQuery(<GovernAuditPage />));

    fireEvent.click(await screen.findByRole('button', { name: 'alice@example.com' }));
    await waitFor(() =>
      expect(urls(spy).some((u) => u.includes(`actorId=${ACTOR}`) && u.includes('offset=0'))).toBe(
        true
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull());
  });

  it('sends the date range as UTC days', async () => {
    const spy = mockLog(2);
    render(withQuery(<GovernAuditPage />));
    await screen.findByText('1–2 of 2');

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-09-30' } });

    await waitFor(() =>
      expect(
        urls(spy).some((u) => u.includes('since=2026-09-01') && u.includes('until=2026-09-30'))
      ).toBe(true)
    );
  });
});
