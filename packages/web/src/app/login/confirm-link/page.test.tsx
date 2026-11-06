// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConfirmMagicLinkPage from './page';

vi.mock('@/lib/config', () => ({ API_BASE: 'https://api.example.com' }));

const assign = vi.fn();
const fetchSpy = vi.fn();

function open(hash: string) {
  window.history.replaceState(null, '', `/login/confirm-link${hash}`);
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign, hash, origin: 'https://app.example.com' },
  });
  vi.stubGlobal('fetch', fetchSpy);
  return render(<ConfirmMagicLinkPage />);
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('/login/confirm-link', () => {
  it('spends nothing on load, and opens the verify URL only on the click', async () => {
    open(
      '#email=ada%40example.com&token=SECRET&callbackURL=https%3A%2F%2Fapp.example.com%2Flogin%3Fbridge%3D1'
    );
    const button = await screen.findByRole('button', { name: 'Sign in as ada@example.com' });
    expect(assign).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.click(button);
    const target = new URL(assign.mock.calls[0]?.[0] as string);
    expect(target.origin + target.pathname).toBe(
      'https://api.example.com/api/auth/magic-link/verify'
    );
    expect(target.searchParams.get('token')).toBe('SECRET');
    expect(target.searchParams.get('callbackURL')).toBe('https://app.example.com/login?bridge=1');
  });

  it('says the link is not valid when it carries no token', async () => {
    open('#email=ada%40example.com');
    expect(await screen.findByText('This sign-in link is not valid')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
