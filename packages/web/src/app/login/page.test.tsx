// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './page';

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => nav.params,
}));

vi.mock('@/stores/authStore', () => {
  const state = {
    hydrateFromSession: async () => 'unauthenticated',
    login: async () => null,
    requestMagicLink: async () => undefined,
    requestPasswordReset: async () => undefined,
    signInWithProvider: async () => undefined,
    user: null,
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
});

function renderWithQuery(query: string) {
  nav.params = new URLSearchParams(query);
  return render(<LoginPage />);
}

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
