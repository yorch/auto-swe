'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type ReadinessItemId = 'credentials' | 'embeddings' | 'github' | 'connections';

export interface ReadinessItem {
  id: ReadinessItemId;
  label: string;
  ok: boolean;
  detail: string;
  /** The studio page (and tab) that fixes this item. */
  href: string;
}

export interface ReadinessProvider {
  provider: string;
  usedBy: string[];
  present: boolean;
}

export interface Readiness {
  ready: boolean;
  items: ReadinessItem[];
  providers: ReadinessProvider[];
}

export const READINESS_KEY = ['platform-readiness'] as const;

/** What a first run needs, derived from real configuration. ADMIN-only on the gateway. */
export function useReadiness(enabled = true) {
  return useQuery({
    enabled,
    queryFn: () => api.get<{ data: Readiness }>('/api/v1/platform/readiness').then((r) => r.data),
    queryKey: READINESS_KEY,
    staleTime: 15_000,
  });
}
