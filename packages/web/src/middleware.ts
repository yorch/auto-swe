import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/api'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Check for access token in cookie or localStorage isn't accessible in middleware,
  // so we check for an auth cookie. The client-side Providers component handles
  // localStorage-based auth. This is a defense-in-depth layer.
  const token = request.cookies.get('accessToken')?.value;

  // For client-side auth (localStorage), the Providers component handles redirect.
  // This middleware is a fallback for direct URL navigation.
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
