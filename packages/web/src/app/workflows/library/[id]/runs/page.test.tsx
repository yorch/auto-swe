// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

import TemplateRunsPage from './page';

const ID = '11111111-1111-4111-8111-111111111111';
const PARAMS = Promise.resolve({ id: ID });

beforeEach(() => resetNavigation('failedStep=build', `/workflows/library/${ID}/runs`));
afterEach(() => vi.unstubAllGlobals());

describe('template run history paging', () => {
  it('starts again from the first page when the failed-step filter clears', async () => {
    const spy = setupFetchMock({
      [`/api/v1/workflow-templates/${ID}`]: () => ({ data: { id: ID, name: 'T', versions: [] } }),
      '/api/v1/workflow-runs': () => ({
        data: [],
        meta: { limit: 20, offset: 0, total: 80 },
      }),
    });
    await act(async () => {
      render(
        withQuery(
          <Suspense fallback={null}>
            <TemplateRunsPage params={PARAMS} />
          </Suspense>
        )
      );
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next page' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() =>
      expect(spy.mock.calls.some(([u]) => String(u).includes('offset=20'))).toBe(true)
    );
    spy.mockClear();
    await act(async () => {
      resetNavigation('', `/workflows/library/${ID}/runs`);
      const { nav } = await import('@/test/mockNavigation');
      for (const l of nav.listeners) {
        l();
      }
    });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls.every(([u]) => !String(u).includes('offset=20'))).toBe(true);
  });

  it('keeps the other filters when the failed-step chip is cleared', async () => {
    resetNavigation('failedStep=build&status=failed&offset=20', `/workflows/library/${ID}/runs`);
    setupFetchMock({
      [`/api/v1/workflow-templates/${ID}`]: () => ({ data: { id: ID, name: 'T', versions: [] } }),
      '/api/v1/workflow-runs': () => ({ data: [], meta: { limit: 20, offset: 0, total: 0 } }),
    });
    await act(async () => {
      render(
        withQuery(
          <Suspense fallback={null}>
            <TemplateRunsPage params={PARAMS} />
          </Suspense>
        )
      );
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    const { nav } = await import('@/test/mockNavigation');
    const last = new URLSearchParams(nav.search);
    expect(last.get('status')).toBe('failed');
    expect(last.has('failedStep')).toBe(false);
    expect(last.has('offset')).toBe(false);
  });
});
