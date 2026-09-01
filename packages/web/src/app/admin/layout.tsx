import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { API_BASE, COOKIE_ACCESS_TOKEN } from '@/lib/config';

interface AuthMeResponse {
  data?: { isActive?: boolean; role?: string };
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

  if (body.data?.role !== 'ADMIN' || body.data?.isActive === false) {
    redirect('/');
  }

  return <>{children}</>;
}
