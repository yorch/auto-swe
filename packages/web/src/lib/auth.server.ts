import type { Role } from '@auto-swe/shared';
import { roleMeets } from '@auto-swe/shared/config/permissions';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_BASE, COOKIE_ACCESS_TOKEN } from '@/lib/config';

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

  const res = await fetch(`${API_BASE}/api/v1/auth/me`, {
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
