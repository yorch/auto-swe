// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hydrate: vi.fn(),
  login: vi.fn(),
  providers: { github: false, google: false, magicLink: true, okta: false },
  push: vi.fn(),
  replace: vi.fn(),
  search: '',
  token: null as string | null,
  user: null as { email?: string; isActive?: boolean } | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: h.push, replace: h.replace }),
  useSearchParams: () => new URLSearchParams(h.search),
}));

vi.mock('@/hooks/useGatewayStatus', () => ({
  isOkResponse: () => true,
  probeGateway: async () => new Response(JSON.stringify(h.providers)),
}));

vi.mock('@/lib/api', () => ({ api: { getToken: () => h.token } }));

vi.mock('@/stores/authStore', () => {
  const state = () => ({
    hydrateFromSession: h.hydrate,
    login: h.login,
    requestMagicLink: vi.fn(),
    requestPasswordReset: vi.fn(),
    signInWithProvider: vi.fn(),
    user: h.user,
  });
  const useAuthStore = Object.assign(
    (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
    { getState: state }
  );
  return { useAuthStore };
});

import LoginPage from './page';

// A request the OAuth provider signed: the signature plus the names it covers.
const OAUTH_QUERY = 'client_id=mcp&scope=read&sig=abc&ba_param=client_id&ba_param=scope';

beforeEach(() => {
  h.providers = { github: false, google: false, magicLink: true, okta: false };
  h.search = '';
  h.token = null;
  h.user = null;
  h.hydrate.mockReset().mockResolvedValue('unauthenticated');
  h.login.mockReset().mockResolvedValue(null);
  h.push.mockReset();
  h.replace.mockReset();
});

afterEach(cleanup);

describe('login page', () => {
  it('offers the magic link tab when the gateway enables it', async () => {
    render(<LoginPage />);
    expect(await screen.findByRole('button', { name: 'Magic link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeTruthy();
  });

  it('hides the magic link tab, and shows the password form, when it is disabled', async () => {
    h.providers = { github: false, google: false, magicLink: false, okta: false };
    render(<LoginPage />);
    expect(await screen.findByLabelText(/^Password/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Magic link' })).toBeNull();
  });

  it('defaults to the password form when an authorization request is pending', async () => {
    h.search = OAUTH_QUERY;
    render(<LoginPage />);
    expect(await screen.findByLabelText(/^Password/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Email me a sign-in link' })).toBeNull();
  });

  it('sends someone who is already signed in on to their destination', async () => {
    h.search = 'redirect=%2Frequests';
    h.token = 'bearer';
    h.user = { isActive: true };
    h.hydrate.mockResolvedValue('authenticated');
    render(<LoginPage />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/requests'));
  });

  it('does not redirect a signed-in person who has no bearer cookie yet', async () => {
    h.hydrate.mockResolvedValue('authenticated');
    h.user = { isActive: true };
    render(<LoginPage />);
    await screen.findByRole('button', { name: 'Magic link' });
    await waitFor(() => expect(h.hydrate).toHaveBeenCalled());
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('does not redirect a signed-in person while an authorization request is pending', async () => {
    h.search = OAUTH_QUERY;
    h.token = 'bearer';
    h.user = { isActive: true };
    h.hydrate.mockResolvedValue('authenticated');
    render(<LoginPage />);
    await screen.findByLabelText(/^Password/);
    // The pending request resumes through the sign-in form; the dashboard redirect would drop it.
    expect(h.hydrate).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('explains a pending approval to an already signed-in deactivated account', async () => {
    h.token = 'bearer';
    h.user = { email: 'new@example.com', isActive: false };
    h.hydrate.mockResolvedValue('authenticated');
    render(<LoginPage />);
    expect(await screen.findByText('Awaiting approval')).toBeTruthy();
    expect(screen.getByText('new@example.com')).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('explains a pending approval after a password sign-in instead of navigating', async () => {
    h.providers = { github: false, google: false, magicLink: false, okta: false };
    h.login.mockImplementation(async () => {
      h.user = { email: 'new@example.com', isActive: false };
      return null;
    });
    render(<LoginPage />);
    fireEvent.change(await screen.findByLabelText(/^Email/), {
      target: { value: 'new@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Awaiting approval')).toBeTruthy();
    expect(h.push).not.toHaveBeenCalled();
  });
});
