// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

import GovernAuditPage from './page';

beforeEach(() => resetNavigation('', '/govern/audit'));
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

    // Wait on plain text: role queries are slow enough in jsdom to time out under load.
    await screen.findByText('alice@example.com');
    const actor = screen.getByRole('button', { name: 'alice@example.com' });
    expect(actor.getAttribute('title')).toContain(ACTOR);
    expect(screen.getByText('system')).toBeTruthy();
  });

  it('drops an actor filter that is not an id instead of erroring the page', async () => {
    resetNavigation('actor=not-a-uuid', '/govern/audit');
    const spy = mockLog(2);
    render(withQuery(<GovernAuditPage />));
    await screen.findByText('alice@example.com');
    expect(urls(spy).every((u) => !u.includes('actorId'))).toBe(true);
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

    await screen.findByText('alice@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'alice@example.com' }));
    await waitFor(() =>
      expect(urls(spy).some((u) => u.includes(`actorId=${ACTOR}`) && u.includes('offset=0'))).toBe(
        true
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull());
  });

  it('sends the date range as UTC days, kept in the URL', async () => {
    const spy = mockLog(2);
    render(withQuery(<GovernAuditPage />));
    await screen.findByText('1–2 of 2');

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByText('Dates are UTC')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('From date (UTC)'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To date (UTC)'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(
        urls(spy).some((u) => u.includes('since=2026-09-01') && u.includes('until=2026-09-30'))
      ).toBe(true)
    );
  });

  it('searches by person or entity', async () => {
    const spy = mockLog(2);
    render(withQuery(<GovernAuditPage />));
    await screen.findByText('1–2 of 2');

    fireEvent.change(screen.getByLabelText('Search by person or entity'), {
      target: { value: 'alice' },
    });

    await waitFor(() => expect(urls(spy).some((u) => u.includes('search=alice'))).toBe(true));
  });

  it('opens a row to its full before and after, and names the column "Change"', async () => {
    mockLog(2);
    render(withQuery(<GovernAuditPage />));
    await screen.findByText('alice@example.com');

    expect(screen.getByRole('columnheader', { name: 'Change' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Show details/ })[0] as HTMLElement);
    expect(screen.getByText('Before')).toBeTruthy();
    expect(screen.getByText(/"role": "ENGINEER"/)).toBeTruthy();
  });

  it('exports the current filter as CSV', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/platform/audit-log': () => ({
        data: [row(1, null)],
        meta: { entityTypes: ['User'], limit: 50, offset: 0, total: 1 },
      }),
      'GET /api/v1/platform/audit-log/export': () => 'time,action\n',
    });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    render(withQuery(<GovernAuditPage />));
    await screen.findByText('1–1 of 1');

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(urls(spy).some((u) => u.includes('/audit-log/export'))).toBe(true));
  });
});
