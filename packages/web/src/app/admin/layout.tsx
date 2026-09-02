import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { API_BASE, COOKIE_ACCESS_TOKEN, PATHNAME_HEADER } from '@/lib/config';

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

  let body: AuthMeResponse;
  try {
    const res = await fetch(`${API_BASE}/api/v1/auth/me`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      redirect('/login');
    }
    body = (await res.json()) as AuthMeResponse;
  } catch {
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
