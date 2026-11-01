// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { ProbeModal } from './ProbeModal';

const PATH = '/api/v1/repositories/repo-1/test-access';

beforeEach(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

function open() {
  return render(withQuery(<ProbeModal onClose={() => {}} path={PATH} title="Test access" />));
}

describe('ProbeModal', () => {
  it('runs the check when it opens and shows a success', async () => {
    const spy = setupFetchMock({
      [`POST ${PATH}`]: () => ({
        data: {
          checks: [{ detail: 'fine', name: 'Token', ok: true }],
          detail: 'Token authenticates as octocat.',
          durationMs: 4,
          ok: true,
        },
      }),
    });
    open();
    expect(await screen.findByText('Token authenticates as octocat.')).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('lists each step when there is more than one, marking the one that failed', async () => {
    setupFetchMock({
      [`POST ${PATH}`]: () => ({
        data: {
          checks: [
            { detail: 'Platform credential can push to acme/api.', name: 'Repository', ok: true },
            { detail: 'Default branch main was not found.', name: 'Default branch', ok: false },
          ],
          detail: 'Default branch main was not found.',
          durationMs: 9,
          ok: false,
        },
      }),
    });
    open();
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Repository');
    expect(items[1]?.textContent).toContain('Default branch');
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('was not found');
  });

  it('shows no step list for a single check, since the alert already says it', async () => {
    setupFetchMock({
      [`POST ${PATH}`]: () => ({
        data: {
          checks: [{ detail: 'The host could not be reached.', name: 'Registry', ok: false }],
          detail: 'The host could not be reached.',
          durationMs: 1,
          ok: false,
        },
      }),
    });
    open();
    await screen.findByText('The host could not be reached.');
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('says so when the request itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      })
    );
    open();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });

  it('runs again on request', async () => {
    const spy = setupFetchMock({
      [`POST ${PATH}`]: () => ({
        data: { checks: [], detail: 'ok now', durationMs: 1, ok: true },
      }),
    });
    open();
    await screen.findByText('ok now');
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
