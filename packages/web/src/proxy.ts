import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  COOKIE_ACCESS_TOKEN,
  COOKIE_SESSION_MARKER,
  PATHNAME_HEADER,
  SEARCH_HEADER,
} from '@/lib/config';

// `/oauth/consent` is public to the proxy because the browser arrives there straight from the
// authorization server (after a social sign-in, say) before this app has set the session marker
// below. The page establishes the session itself and every call it makes is authenticated by the
// gateway, so nothing is exposed by letting the page load.
const PUBLIC_PATHS = ['/login', '/api', '/reset-password', '/health', '/oauth/consent'];

/** Pages that take a credential or a security decision, and so must never be framed. */
const FRAME_PROTECTED_PATHS = ['/login', '/oauth/consent'];

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
/**
 * Forward the matched pathname and query string to Server Components. Layouts
 * have no access to the URL, and the reauth redirect in `auth.server.ts` needs
 * both to send the user back to exactly the page they were on. Both headers are
 * always set (never merely passed through), so a client-sent value is replaced.
 */
function nextWithPathname(request: NextRequest, pathname: string) {
  const headers = new Headers(request.headers);
  headers.set(PATHNAME_HEADER, pathname);
  headers.set(SEARCH_HEADER, request.nextUrl.search);
  const response = NextResponse.next({ request: { headers } });
  if (FRAME_PROTECTED_PATHS.some((p) => pathname.startsWith(p))) {
    // Clickjacking: a page that asks "approve this app?" or "sign in" cannot sit in a frame.
    response.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
    response.headers.set('X-Frame-Options', 'DENY');
  }
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return nextWithPathname(request, pathname);
  }

  const hasLegacyToken = Boolean(request.cookies.get(COOKIE_ACCESS_TOKEN)?.value);
  const hasBetterAuthMarker = Boolean(request.cookies.get(COOKIE_SESSION_MARKER)?.value);

  if (!(hasLegacyToken || hasBetterAuthMarker)) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  return nextWithPathname(request, pathname);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
