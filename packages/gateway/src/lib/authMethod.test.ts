import { describe, expect, it } from 'vitest';
import { classifySignInFailure, isSignInPath, signInMethodFor } from './authMethod.js';

const apiError = (statusCode: number, code?: string, location?: string) => ({
  body: code ? { code } : undefined,
  headers: location ? new Headers({ location }) : new Headers(),
  name: 'APIError',
  statusCode,
});

describe('signInMethodFor', () => {
  it.each([
    [{ path: '/sign-in/email' }, 'password'],
    [{ path: '/sign-up/email' }, 'password'],
    [{ path: '/verify-email' }, 'password'],
    [{ path: '/magic-link/verify' }, 'magic-link'],
    [{ params: { id: 'github' }, path: '/callback/:id' }, 'github'],
    [{ params: { id: 'Google' }, path: '/callback/:id' }, 'google'],
    [{ params: { id: 'okta' }, path: '/callback/:id' }, 'okta'],
    [{ params: { id: 'acme-sso' }, path: '/callback/:id' }, 'oauth'],
    [{ body: { provider: 'github' }, path: '/sign-in/social' }, 'github'],
    [{ body: {}, path: '/sign-in/social' }, 'oauth'],
    [{ path: '/get-session' }, 'unknown'],
    [{}, 'unknown'],
  ])('%j is %s', (ctx, expected) => {
    expect(signInMethodFor(ctx)).toBe(expected);
  });
});

describe('isSignInPath', () => {
  it('covers the sign-in endpoints and not sign-up or sign-out', () => {
    expect(isSignInPath('/sign-in/email')).toBe(true);
    expect(isSignInPath('/callback/:id')).toBe(true);
    expect(isSignInPath('/sign-up/email')).toBe(false);
    expect(isSignInPath('/sign-out')).toBe(false);
    expect(isSignInPath(undefined)).toBe(false);
  });
});

describe('classifySignInFailure', () => {
  it('treats a non-error result as success', () => {
    expect(classifySignInFailure(undefined)).toBeNull();
    expect(classifySignInFailure({ user: { id: 'u' } })).toBeNull();
  });

  it('maps error codes to reasons', () => {
    expect(classifySignInFailure(apiError(401, 'INVALID_EMAIL_OR_PASSWORD'))).toBe(
      'invalid_credentials'
    );
    expect(classifySignInFailure(apiError(403, 'EMAIL_NOT_VERIFIED'))).toBe('unverified');
    expect(classifySignInFailure(apiError(403, 'USER_BANNED'))).toBe('locked');
    expect(classifySignInFailure(apiError(429))).toBe('other');
  });

  it('reads a redirect as a failure only when it carries an error', () => {
    expect(classifySignInFailure(apiError(302, undefined, '/dashboard'))).toBeNull();
    expect(classifySignInFailure(apiError(302, undefined, '/login?error=INVALID_TOKEN'))).toBe(
      'other'
    );
    expect(classifySignInFailure(apiError(302, undefined, '/login?error=email_not_verified'))).toBe(
      'unverified'
    );
  });
});
