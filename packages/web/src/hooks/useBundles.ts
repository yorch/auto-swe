'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** A row in the installed-bundle registry (P4/WS3). */
export interface InstalledBundleRow {
  name: string;
  version: string;
  source: string | null;
  trustState: string;
  signedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const BASE = '/api/v1/admin/bundles';
const KEY = ['admin-bundles'];

export function useInstalledBundles() {
  return useQuery({
    queryFn: () => api.get<{ data: InstalledBundleRow[] }>(BASE).then((r) => r.data),
    queryKey: KEY,
  });
}

export function useInstallBundleFromUrl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => api.post(`${BASE}/install-from-url`, { url }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useExportBundle() {
  return useMutation({
    mutationFn: (body: { name: string; version: string; origin?: string }) =>
      api.post<{ data: unknown }>(`${BASE}/export`, body).then((r) => r.data),
  });
}
