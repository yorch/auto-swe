'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** An admin-managed package registry upstream (npm, Go, PyPI or Maven), with a write-only token. */
export interface PackageRegistryRow {
  id: string;
  name: string;
  ecosystem: 'npm' | 'go' | 'pypi' | 'maven';
  upstreamUrl: string;
  npmScopes: string[];
  accessMode: 'lockfile' | 'open';
  allowPrivateNetwork: boolean;
  authKind: 'bearer' | 'basic';
  teamId: string | null;
  isActive: boolean;
  hasToken: boolean;
  tokenLastFour: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PackageRegistryBody {
  /** Chosen at creation; the gateway refuses to change it afterwards. */
  ecosystem: 'npm' | 'go' | 'pypi' | 'maven';
  name: string;
  upstreamUrl: string;
  npmScopes: string[];
  accessMode: 'lockfile' | 'open';
  allowPrivateNetwork: boolean;
  authKind: 'bearer' | 'basic';
  teamId: string | null;
  token?: string;
  isActive?: boolean;
}

const BASE = '/api/v1/admin/package-registries';
const KEY = ['admin-package-registries'];

export function usePackageRegistries() {
  return useQuery({
    queryFn: () => api.get<{ data: PackageRegistryRow[] }>(BASE).then((r) => r.data),
    queryKey: KEY,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

export function useCreatePackageRegistry() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: PackageRegistryBody) =>
      api.post<{ data: PackageRegistryRow }>(BASE, body).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useUpdatePackageRegistry(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: Partial<PackageRegistryBody>) =>
      api.patch<{ data: PackageRegistryRow }>(`${BASE}/${id}`, body).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useDeletePackageRegistry() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/${id}`),
    onSuccess: invalidate,
  });
}
