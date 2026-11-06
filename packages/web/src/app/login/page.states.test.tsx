// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hydrate: vi.fn(),
  magic: vi.fn(),
  probe: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
  search: '',
  user: null as { email?: string; isActive?: boolean } | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: h.replace }),
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock('@/hooks/useGatewayStatus', () => ({
  isOkResponse: () => true,
  probeGateway: (...args: unknown[]) => h.probe(...args),
}));
vi.mock('@/lib/api', () => ({ api: { getToken: () => null } }));
vi.mock('@/stores/authStore', () => {
  const state = () => ({
    hydrateFromSession: h.hydrate,
    login: vi.fn(),
    logout: vi.fn(),
    requestMagicLink: h.magic,
    requestPasswordReset: h.reset,
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

const ok = (flags: Record<string, boolean>) => new Response(JSON.stringify(flags));
const MAGIC = { github: false, google: false, magicLink: true, okta: false };
const PASSWORD = { github: false, google: false, magicLink: false, okta: false };

beforeEach(() => {
  h.search = '';
  h.user = null;
  h.hydrate.mockReset().mockResolvedValue('unauthenticated');
  h.magic.mockReset().mockResolvedValue(undefined);
  h.reset.mockReset().mockResolvedValue(undefined);
  h.replace.mockReset();
  h.probe.mockReset().mockResolvedValue(ok(MAGIC));
});
afterEach(cleanup);

describe('login page: gateway down', () => {
  it('offers Retry, disables submit, and recovers when the probe succeeds', async () => {
    h.probe.mockResolvedValueOnce(null);
    render(<LoginPage />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
    const submit = await screen.findByRole('button', { name: 'Email me a sign-in link' });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('re-probes when the browser comes back online', async () => {
    h.probe.mockResolvedValueOnce(null);
    render(<LoginPage />);
    await screen.findByRole('button', { name: 'Retry' });
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
  });
});

describe('login page: magic link', () => {
  it('shows a check-your-inbox state with a resend cooldown', async () => {
    render(<LoginPage />);
    fireEvent.change(await screen.findByLabelText(/^Email/), { target: { value: 'a@b.co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByText('Check your inbox')).toBeTruthy();
    expect(screen.getByText('a@b.co')).toBeTruthy();
    const resend = screen.getByRole('button', { name: /^Resend in \d+s$/ }) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(await screen.findByRole('button', { name: 'Email me a sign-in link' })).toBeTruthy();
    expect(h.magic).toHaveBeenCalledTimes(1);
  });

  it('reports an empty email inline instead of sending', async () => {
    render(<LoginPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByText('Enter your email address.')).toBeTruthy();
    expect(h.magic).not.toHaveBeenCalled();
  });
});

describe('login page: password form', () => {
  beforeEach(() => h.probe.mockResolvedValue(ok(PASSWORD)));

  it('uses username autofill for the email and no fake placeholder for the password', async () => {
    render(<LoginPage />);
    const email = (await screen.findByLabelText(/^Email/)) as HTMLInputElement;
    expect(email.autocomplete).toBe('username');
    expect((screen.getByLabelText(/^Password/) as HTMLInputElement).placeholder).toBe('');
  });

  it('puts the forgot-password error on the email field and focuses it', async () => {
    render(<LoginPage />);
    const email = await screen.findByLabelText(/^Email/);
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByText(/Enter the email for your account/)).toBeTruthy();
    expect(document.activeElement).toBe(email);
    expect(h.reset).not.toHaveBeenCalled();
  });
});

describe('login page: awaiting approval', () => {
  it('lets the person check again and continues once approved', async () => {
    h.user = { email: 'new@example.com', isActive: false };
    h.hydrate.mockResolvedValue('authenticated');
    render(<LoginPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Still waiting for approval.')).toBeTruthy();
    h.user = { email: 'new@example.com', isActive: true };
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/'));
  });
});

describe('login page: a used magic link', () => {
  it('says the link expired or was used, rather than looking for a session', async () => {
    h.search = 'bridge=1&error=INVALID_TOKEN';
    render(<LoginPage />);
    expect(await screen.findByText(/expired or was already used/i)).toBeTruthy();
    expect(screen.queryByText(/no session was found/i)).toBeNull();
  });
});
