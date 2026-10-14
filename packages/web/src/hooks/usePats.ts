'use client';

import type { PatCreated, PatSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type { PatCreated, PatSummary };

export function usePersonalAccessTokens() {
  return useQuery({
    queryFn: () => api.get<{ data: PatSummary[] }>('/api/v1/auth/tokens').then((r) => r.data),
    queryKey: ['pats'],
  });
}

export function useCreatePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; expiresInDays?: number }) =>
      api.post<{ data: PatCreated }>('/api/v1/auth/tokens', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pats'] }),
  });
}

export function useRevokePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/auth/tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pats'] }),
  });
}
