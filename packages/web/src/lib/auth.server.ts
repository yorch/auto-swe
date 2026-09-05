import type { Role } from '@auto-swe/shared';
import { roleMeets } from '@auto-swe/shared/config/permissions';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE_ACCESS_TOKEN } from '@/lib/config';
import { apiInternalUrl } from '@/lib/env';

interface SessionUser {
  id: string;
  email: string;
  role: Role;
  isActive: boolean;
}

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_ACCESS_TOKEN)?.value;

  if (!token) {
    return null;
  }

  // Server-side: this runs inside the web container, where the browser-facing
  // API URL (often http://localhost:8080) points at the container's own
  // loopback. API_INTERNAL_URL names the gateway on the compose network.
  const res = await fetch(`${apiInternalUrl()}/api/v1/auth/me`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    return null;
  }

  const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
  const user = json?.data as SessionUser | undefined;

  if (!user || typeof user.role !== 'string') {
    return null;
  }

  return user;
}

export async function requireRole(allowed: Role[]): Promise<SessionUser> {
  const user = await getSession();

  if (!user?.isActive || !allowed.some((r) => roleMeets(user.role, r))) {
    redirect('/');
  }

  return user;
}
