// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { GitHubTab } from './GitHubTab';

vi.mock('./GitHubHostCredentialsCard', () => ({ GitHubHostCredentialsCard: () => null }));
vi.mock('./GitHubHostSecretsCard', () => ({ GitHubHostSecretsCard: () => null }));

afterEach(() => vi.unstubAllGlobals());

const config = (authMode: string | null) => ({
  data: {
    apiUrl: null,
    appClientId: null,
    appClientSecret: null,
    appId: null,
    appInstallationId: null,
    appPrivateKey: null,
    authMode,
    baseUrl: null,
    token: { lastFour: 'abcd' },
    webhookSecret: null,
  },
  sources: {},
});

describe('GitHubTab', () => {
  it('shows the saved auth mode rather than "auto"', async () => {
    setupFetchMock({ '/api/v1/platform/config/github': () => config('pat') });
    render(withQuery(<GitHubTab />));
    const select = await screen.findByRole('button', { name: /auth mode/i });
    expect(select.textContent).toContain('Token: always use the personal access token');
  });

  it('tests with the typed token and labels the result as unsaved', async () => {
    const spy = setupFetchMock({
      '/api/v1/platform/config/github': () => config('pat'),
      'POST /api/v1/platform/config/github/test': () => ({
        detail: 'Authenticated as me',
        ok: true,
      }),
    });
    render(withQuery(<GitHubTab />));
    const token = await screen.findByLabelText(/personal access token/i, { selector: 'input' });
    fireEvent.change(token, { target: { value: 'ghp_typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByText('Tested with unsaved values.')).toBeTruthy());
    expect(bodyOf(spy, '/config/github/test')).toEqual({ token: 'ghp_typed' });
  });

  it('tests the stored config, without the unsaved label, when nothing was typed', async () => {
    const spy = setupFetchMock({
      '/api/v1/platform/config/github': () => config('pat'),
      'POST /api/v1/platform/config/github/test': () => ({
        detail: 'Authenticated as me',
        ok: true,
      }),
    });
    render(withQuery(<GitHubTab />));
    await screen.findByLabelText(/personal access token/i, { selector: 'input' });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByText(/Authenticated as me/)).toBeTruthy());
    expect(bodyOf(spy, '/config/github/test')).toEqual({});
    expect(screen.queryByText('Tested with unsaved values.')).toBeNull();
  });
});

describe('GitHubTab secret clearing', () => {
  it('shows where a secret comes from and clears a stored one after confirmation', async () => {
    stubDialogPrototype();
    const spy = setupFetchMock({
      '/api/v1/platform/config/github': () => config('pat'),
      'DELETE /api/v1/platform/config/github/secrets/token': () => ({ data: {}, sources: {} }),
    });
    render(withQuery(<GitHubTab />));
    expect(await screen.findByText(/Stored in DB \(ending abcd\)/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear stored value for Personal access token' })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Clear value' }));
    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/config/github/secrets/token') &&
            (init as RequestInit | undefined)?.method === 'DELETE'
        )
      ).toBe(true)
    );
  });
});
