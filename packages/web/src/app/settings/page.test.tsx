// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';

const h = vi.hoisted(() => ({
  reset: vi.fn(),
  user: { email: 'me@example.com', role: 'ENGINEER', slackId: 'U123', sub: 'u1' } as {
    email: string;
    role: string;
    slackId?: string;
    sub: string;
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/settings/AccessTokensSection', () => ({ AccessTokensSection: () => null }));
vi.mock('@/components/settings/ConnectedAppsSection', () => ({ ConnectedAppsSection: () => null }));
vi.mock('@/components/settings/GitHubCredentialsSection', () => ({
  GitHubCredentialsSection: () => null,
}));
vi.mock('@/stores/authStore', () => {
  const state = () => ({
    linkProvider: vi.fn(),
    logout: vi.fn(),
    requestPasswordReset: h.reset,
    user: h.user,
  });
  return { useAuthStore: (select: (s: ReturnType<typeof state>) => unknown) => select(state()) };
});

import SettingsPage from './page';

const PROVIDERS = { github: true, google: true, magicLink: true, okta: false };

function gateway(accounts: { id: string; providerId: string; accountId: string }[]) {
  setupFetchMock({
    'GET /api/auth/list-accounts': () => accounts,
    'GET /api/v1/auth/providers': () => PROVIDERS,
  });
}

beforeEach(() => {
  stubDialogPrototype();
  h.reset.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('settings: sign-in methods', () => {
  it('disables Unlink for the only sign-in method and says why', async () => {
    gateway([{ accountId: 'gh-1', id: 'a1', providerId: 'github' }]);
    render(withQuery(<SettingsPage />));
    const unlink = (await screen.findByRole('button', { name: 'Unlink' })) as HTMLButtonElement;
    expect(unlink.disabled).toBe(true);
    expect(screen.getByText(/only sign-in method/)).toBeTruthy();
  });

  it('allows Unlink when another method remains, and shows that a password is set', async () => {
    gateway([
      { accountId: 'gh-1', id: 'a1', providerId: 'github' },
      { accountId: 'u1', id: 'a2', providerId: 'credential' },
    ]);
    render(withQuery(<SettingsPage />));
    const unlink = (await screen.findByRole('button', { name: 'Unlink' })) as HTMLButtonElement;
    expect(unlink.disabled).toBe(false);
    expect(screen.getByText('Password set')).toBeTruthy();
  });

  it('sends a password reset link from the page and reports it in the section', async () => {
    gateway([]);
    render(withQuery(<SettingsPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Email me a reset link' }));
    await waitFor(() => expect(h.reset).toHaveBeenCalledWith('me@example.com'));
    expect(await screen.findByText(/a password reset link is on its way/)).toBeTruthy();
    const section = document.getElementById('sign-in') as HTMLElement;
    expect(section.textContent).toContain('a password reset link is on its way');
  });

  it('tells a connected Slack user who can disconnect it', async () => {
    gateway([]);
    render(withQuery(<SettingsPage />));
    expect(await screen.findByText(/Only an administrator can disconnect it/)).toBeTruthy();
  });
});
