'use client';

import type { AdminTokenSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ScannerPattern {
  createdAt: string;
  flags: string;
  id: string;
  isActive: boolean;
  isBuiltIn: boolean;
  label: string;
  pattern: string;
  type: 'INJECTION' | 'EXFILTRATION';
  updatedAt: string;
}

export function useScannerPatterns() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: ScannerPattern[] }>('/api/v1/admin/scanner-patterns').then((r) => r.data),
    queryKey: ['scanner-patterns'],
  });
}

export function useCreateScannerPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      flags: string;
      label: string;
      pattern: string;
      type: 'INJECTION' | 'EXFILTRATION';
    }) =>
      api
        .post<{ data: ScannerPattern }>('/api/v1/admin/scanner-patterns', body)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scanner-patterns'] }),
  });
}

export function useUpdateScannerPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      flags?: string;
      id: string;
      isActive?: boolean;
      label?: string;
      pattern?: string;
      type?: 'INJECTION' | 'EXFILTRATION';
    }) =>
      api
        .put<{ data: ScannerPattern }>(`/api/v1/admin/scanner-patterns/${id}`, body)
        .then((r) => r.data),
    onSuccess: (result) => {
      qc.setQueryData<ScannerPattern[]>(['scanner-patterns'], (old) => {
        if (!old) {
          return old;
        }
        return old.map((p) => (p.id === result.id ? result : p));
      });
    },
  });
}

export function useDeleteScannerPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/scanner-patterns/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scanner-patterns'] }),
  });
}

interface AdminSessionSummary {
  id: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  user: { id: string; email: string };
}

export function useAdminTokens() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: AdminTokenSummary[] }>('/api/v1/admin/access-tokens').then((r) => r.data),
    queryKey: ['admin-tokens'],
    refetchInterval: 30_000,
  });
}

export function useAdminRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/access-tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-tokens'] }),
  });
}

export function useAdminPruneShellAudit(days = 90) {
  return useMutation({
    mutationFn: () => api.post(`/api/v1/admin/shell-audit/prune?days=${days}`, {}),
  });
}

export function useAdminSessions() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: AdminSessionSummary[] }>('/api/v1/admin/sessions').then((r) => r.data),
    queryKey: ['admin-sessions'],
    refetchInterval: 30_000,
  });
}

export function useAdminRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-sessions'] }),
  });
}
