// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

import GovernScannerPage from './page';

beforeEach(() => {
  resetNavigation('', '/admin/scanner');
  stubDialogPrototype();
});
afterEach(() => vi.unstubAllGlobals());

function pattern(over: Record<string, unknown>) {
  return {
    createdAt: '2026-09-01T00:00:00.000Z',
    flags: 'i',
    id: 'p1',
    isActive: true,
    isBuiltIn: false,
    label: 'ignore-previous',
    origin: null,
    pattern: 'ignore previous',
    type: 'INJECTION',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function mock(patterns: Record<string, unknown>[]) {
  return setupFetchMock({
    'GET /api/v1/platform/scanner-patterns': () => ({ data: patterns }),
    'PATCH /api/v1/platform/scanner-patterns/p1': () => ({ data: {} }),
    'PUT /api/v1/platform/scanner-patterns/p1': () => ({ data: {} }),
  });
}

describe('scanner patterns page', () => {
  it('says injection patterns also guard memory, not just that they are advisory', async () => {
    mock([pattern({})]);
    render(withQuery(<GovernScannerPage />));
    expect((await screen.findAllByText('Advisory · blocks memory')).length).toBeGreaterThan(0);
  });

  it('confirms before an injection rule is switched off, naming the memory guard', async () => {
    const spy = mock([pattern({})]);
    render(withQuery(<GovernScannerPage />));
    fireEvent.click(await screen.findByRole('switch', { name: 'Active: ignore-previous' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/memory writes and recalls it catches/)).toBeTruthy();
    expect(
      spy.mock.calls.some(([, init]) =>
        ['PUT', 'PATCH'].includes(String((init as RequestInit | undefined)?.method))
      )
    ).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable rule' }));
    await waitFor(() =>
      expect(
        spy.mock.calls.some(([, init]) =>
          ['PUT', 'PATCH'].includes(String((init as RequestInit | undefined)?.method))
        )
      ).toBe(true)
    );
  });

  it('reads its filters from the URL', async () => {
    resetNavigation('state=inactive', '/admin/scanner');
    mock([pattern({}), pattern({ id: 'p2', isActive: false, label: 'switched-off' })]);
    render(withQuery(<GovernScannerPage />));
    expect(await screen.findByText('switched-off')).toBeTruthy();
    expect(screen.queryByText('ignore-previous')).toBeNull();
  });
});
