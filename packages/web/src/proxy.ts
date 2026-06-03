import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { COOKIE_ACCESS_TOKEN, COOKIE_SESSION_MARKER } from '@/lib/config';

const PUBLIC_PATHS = ['/login', '/api', '/reset-password', '/health'];

/**
 * Two cookies can signal an authenticated session to this proxy:
 *
 *   - `accessToken` (legacy): the JWT itself, set by the email+password
 *     login flow. The proxy only checks presence — the gateway is the
 *     real validator.
 *   - `web-session-active` (better-auth path): a marker the authStore
 *     drops after a successful magic-link or social sign-in. The actual
 *     session cookie (`better-auth.session_token`) lives on the gateway
 *     origin and isn't visible to this proxy.
 *
 * Either is enough to let the request through; the gateway's requireAuth
 * still enforces real auth on every /api/v1/* call.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const hasLegacyToken = Boolean(request.cookies.get(COOKIE_ACCESS_TOKEN)?.value);
  const hasBetterAuthMarker = Boolean(request.cookies.get(COOKIE_SESSION_MARKER)?.value);

  if (!(hasLegacyToken || hasBetterAuthMarker)) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
