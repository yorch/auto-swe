// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { ShellAuditPrune } from './ShellAuditPrune';

const isAdmin = vi.hoisted(() => ({ value: true }));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => isAdmin.value }));

const PATH = '/api/v1/platform/shell-audit/prune';

beforeEach(() => {
  isAdmin.value = true;
  stubDialogPrototype();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function urls(spy: ReturnType<typeof setupFetchMock>) {
  return spy.mock.calls.map(([u, init]) => `${init?.method ?? 'GET'} ${String(u)}`);
}

describe('ShellAuditPrune', () => {
  it('renders nothing for a non-admin', () => {
    isAdmin.value = false;
    const { container } = render(withQuery(<ShellAuditPrune />));
    expect(container.textContent).toBe('');
  });

  it('previews with dryRun and deletes nothing until confirmed', async () => {
    const spy = setupFetchMock({
      [`POST ${PATH}`]: () => ({ data: { deleted: 4, dryRun: true, olderThanDays: 30 } }),
    });
    render(withQuery(<ShellAuditPrune />));
    fireEvent.change(screen.getByLabelText('Older than (days)'), { target: { value: '30' } });
    expect((screen.getByRole('button', { name: 'Delete…' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const note = await screen.findByTestId('shell-audit-preview');
    expect(note.textContent).toContain('4 rows older than 30 days');
    expect(urls(spy).some((u) => u.includes('days=30&dryRun=true'))).toBe(true);
    expect(urls(spy).some((u) => u.includes('dryRun=false'))).toBe(false);
  });

  it('deletes after confirmation and shows the deleted count', async () => {
    let calls = 0;
    const spy = setupFetchMock({
      [`POST ${PATH}`]: () => ({
        data: { deleted: 4, dryRun: calls++ === 0, olderThanDays: 90 },
      }),
    });
    render(withQuery(<ShellAuditPrune />));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByTestId('shell-audit-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(urls(spy).some((u) => u.includes('dryRun=false'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/Deleted 4 shell audit rows/)).toBeTruthy();
    await waitFor(() =>
      expect(urls(spy).some((u) => u.includes('days=90&dryRun=false'))).toBe(true)
    );
  });

  it('refuses an out-of-range window', () => {
    render(withQuery(<ShellAuditPrune />));
    fireEvent.change(screen.getByLabelText('Older than (days)'), { target: { value: '0' } });
    expect((screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });
});
