import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { API_BASE, COOKIE_ACCESS_TOKEN } from '@/lib/config';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_ACCESS_TOKEN)?.value;

  if (!token) {
    redirect('/login');
  }

  const res = await fetch(`${API_BASE}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    redirect('/login');
  }

  const body = (await res.json()) as { data?: { role?: string } };
  if (body.data?.role !== 'ADMIN') {
    redirect('/');
  }

  return <>{children}</>;
}
