import { describe, expect, it } from 'vitest';
import { magicLinkConfirmUrl } from './magicLinkConfirm.js';

describe('magicLinkConfirmUrl', () => {
  it('points at the confirmation page, with the token only in the fragment', () => {
    const url = new URL(
      magicLinkConfirmUrl(
        'https://api.example.com/api/auth/magic-link/verify?token=SECRET&callbackURL=https%3A%2F%2Fapp.example.com%2Flogin%3Fbridge%3D1',
        'https://app.example.com',
        'ada@example.com'
      )
    );
    expect(url.origin + url.pathname).toBe('https://app.example.com/login/confirm-link');
    expect(url.search).toBe('');
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get('token')).toBe('SECRET');
    expect(fragment.get('email')).toBe('ada@example.com');
    expect(fragment.get('callbackURL')).toBe('https://app.example.com/login?bridge=1');
  });

  it('refuses a URL with no token', () => {
    expect(() =>
      magicLinkConfirmUrl('https://api.example.com/x', 'https://app.example.com', 'a@b.c')
    ).toThrow(/no token/);
  });
});
