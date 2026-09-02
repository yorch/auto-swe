'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { LoadingState } from '@/components/ui/LoadingState';
import { useAuthStore } from '@/stores/authStore';

const ALLOWED = new Set(['ENGINEER', 'LEAD', 'ADMIN']);

export default function GovernLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    checkAuth().finally(() => setReady(true));
  }, [checkAuth]);

  if (!ready) {
    return <LoadingState message="checking access…" />;
  }

  if (!user || !ALLOWED.has(user.role)) {
    router.replace('/');
    return null;
  }

  return <>{children}</>;
}
