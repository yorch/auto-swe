import { NextResponse } from 'next/server';

// Lightweight liveness probe for the container HEALTHCHECK. Public — listed in
// the proxy's PUBLIC_PATHS so it never redirects to /login.
export function GET() {
  return NextResponse.json({ status: 'ok' });
}
