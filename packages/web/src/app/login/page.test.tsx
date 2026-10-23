// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './page';

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
// What the mocked auth store reports; a test overrides it to reach the pending-approval screen.
const auth = vi.hoisted(() => ({
  status: 'unauthenticated' as 'authenticated' | 'unauthenticated',
  user: null as { email: string; isActive: boolean } | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => nav.params,
}));

vi.mock('@/stores/authStore', () => {
  const state = {
    hydrateFromSession: async () => auth.status,
    login: async () => null,
    requestMagicLink: async () => undefined,
    requestPasswordReset: async () => undefined,
    signInWithProvider: async () => undefined,
    get user() {
      return auth.user;
    },
  };
  const useAuthStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state,
  });
  return { useAuthStore };
});

// The page probes the gateway for its providers before it shows anything else.
vi.mock('@/hooks/useGatewayStatus', () => ({
  isOkResponse: () => true,
  probeGateway: async () =>
    new Response(JSON.stringify({ github: true, google: false, magicLink: false, okta: false }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }),
}));

afterEach(() => {
  cleanup();
  nav.params = new URLSearchParams();
  auth.status = 'unauthenticated';
  auth.user = null;
});

function renderWithQuery(query: string) {
  nav.params = new URLSearchParams(query);
  return render(<LoginPage />);
}

describe('login page: support contact', () => {
  afterEach(() => {
    (window as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__ = undefined;
  });

  it('shows the configured support contact below the sign-in card', async () => {
    (window as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__ = {
      support: { email: 'help@example.com' },
    };
    renderWithQuery('');
    expect(await screen.findByRole('link', { name: 'help@example.com' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Support' })).toBeTruthy();
  });

  it('shows the support contact on the awaiting-approval screen too', async () => {
    (window as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__ = {
      support: { email: 'help@example.com' },
    };
    auth.status = 'authenticated';
    auth.user = { email: 'new.hire@example.com', isActive: false };
    renderWithQuery('');
    expect(await screen.findByText('Awaiting approval')).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'help@example.com' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Support' })).toBeTruthy();
  });

  it('adds no support element on the awaiting-approval screen when nothing is configured', async () => {
    auth.status = 'authenticated';
    auth.user = { email: 'new.hire@example.com', isActive: false };
    renderWithQuery('');
    expect(await screen.findByText('Awaiting approval')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Support' })).toBeNull();
    expect(screen.queryByText('Support')).toBeNull();
  });

  it('adds no support element when nothing is configured', async () => {
    renderWithQuery('');
    await screen.findByText(
      'auto-swe turns a ticket into a pull request for you to review and merge.'
    );
    expect(screen.queryByRole('group', { name: 'Support' })).toBeNull();
    expect(screen.queryByText('Support')).toBeNull();
  });
});

describe('login page: what it is and how to get in', () => {
  it('says what auto-swe does and points a new user to an administrator', async () => {
    renderWithQuery('');

    const line = await screen.findByText(
      'auto-swe turns a ticket into a pull request for you to review and merge.'
    );
    // The brand aside is `hidden lg:flex`; jsdom ignores CSS, so assert the line is not in it.
    expect(line.closest('aside')).toBeNull();
    expect(
      screen.getByText(
        'New here? New accounts usually need an administrator’s approval, or ask an administrator for an invite.'
      )
    ).toBeTruthy();
  });
});

describe('login page: a failed sign-in callback', () => {
  it('explains a profile failure in plain language', async () => {
    renderWithQuery('error=unable_to_get_user_info');

    expect(await screen.findByText(/couldn't read your profile/i)).toBeTruthy();
    expect(screen.queryByText(/unable_to_get_user_info/)).toBeNull();
  });

  it('explains a cancelled sign-in', async () => {
    renderWithQuery('error=access_denied');

    expect(await screen.findByText(/cancelled or denied/i)).toBeTruthy();
  });

  it('names an unfamiliar but well-formed code so it can be reported', async () => {
    renderWithQuery('error=some_new_error');

    expect(await screen.findByText(/some_new_error/)).toBeTruthy();
  });

  it('never renders a hostile code as markup or text', async () => {
    const { container } = renderWithQuery(
      `error=${encodeURIComponent('<img src=x onerror=alert(1)>')}`
    );

    expect(await screen.findByText(/sign-in failed/i)).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.textContent).not.toContain('onerror');
  });

  it('shows no error banner on an ordinary visit', async () => {
    renderWithQuery('');

    await waitFor(() =>
      expect(screen.getAllByText(/continue with github/i).length).toBeGreaterThan(0)
    );
    expect(screen.queryByText(/sign-in failed/i)).toBeNull();
    expect(screen.queryByText(/couldn't read your profile/i)).toBeNull();
  });
});
