import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { COOKIE_ACCESS_TOKEN, PATHNAME_HEADER } from '@/lib/config';
import { apiInternalUrl } from '@/lib/env';

interface AuthMeResponse {
  data?: { isActive?: boolean; role?: string };
}

/**
 * /admin paths a LEAD may open. Everything else under /admin is ADMIN-only.
 * The settings page authorises per setting (a lead may hold a write grant on
 * some keys), so the layout must not turn it away at the door.
 */
const LEAD_ALLOWED_PREFIXES = ['/admin/settings'];

function leadMayOpen(pathname: string | null): boolean {
  if (!pathname) {
    return false;
  }
  return LEAD_ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_ACCESS_TOKEN)?.value;

  if (!token) {
    redirect('/login');
  }

  // redirect() works by throwing, so it must not be called inside the try —
  // the catch would swallow it. Resolve the body first, then decide.
  let body: AuthMeResponse | null = null;
  try {
    const res = await fetch(`${apiInternalUrl()}/api/v1/auth/me`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      body = (await res.json()) as AuthMeResponse;
    }
  } catch {
    body = null;
  }
  if (!body) {
    redirect('/login');
  }

  const role = body.data?.role;
  const pathname = (await headers()).get(PATHNAME_HEADER);
  const allowed = role === 'ADMIN' || (role === 'LEAD' && leadMayOpen(pathname));
  if (!allowed || body.data?.isActive === false) {
    redirect('/');
  }

  return <>{children}</>;
}
