'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { buildCaches } from '@/lib/refusalRefresh';
import { useAuthStore } from '@/stores/authStore';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => {
    const holder: { client: QueryClient | null } = { client: null };
    const client = new QueryClient({
      ...buildCaches(() => holder.client),
      defaultOptions: {
        queries: {
          retry: 1,
          staleTime: 30_000,
        },
      },
    });
    holder.client = client;
    return client;
  });

  const checkAuth = useAuthStore((s) => s.checkAuth);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
