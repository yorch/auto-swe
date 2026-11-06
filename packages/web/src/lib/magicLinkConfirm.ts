import { API_BASE } from '@/lib/config';

export interface EmailedLink {
  callbackURL: string | null;
  email: string | null;
  token: string;
}

/** The token, address and callback a sign-in email carries in its fragment. */
export function readEmailedLink(hash: string): EmailedLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('token');
  return token
    ? { callbackURL: params.get('callbackURL'), email: params.get('email'), token }
    : null;
}

/** better-auth's verify URL, which spends the token and signs the browser in. */
export function magicLinkVerifyUrl(link: EmailedLink): string {
  const url = new URL('/api/auth/magic-link/verify', API_BASE || window.location.origin);
  url.searchParams.set('token', link.token);
  url.searchParams.set('callbackURL', link.callbackURL ?? `${window.location.origin}/login`);
  return url.toString();
}
