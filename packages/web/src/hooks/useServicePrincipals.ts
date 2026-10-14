'use client';

import type {
  ServicePrincipalSummary,
  ServiceTokenCreated,
  ServiceTokenScope,
  ServiceTokenSummary,
} from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type { ServicePrincipalSummary, ServiceTokenCreated, ServiceTokenSummary };

/** What the create and edit forms send. */
export interface ServicePrincipalInput {
  name: string;
  description: string | null;
  maxRunsPerDay: number;
  maxInFlight: number;
  connectionIds: string[];
  templateIds: string[];
}

const base = (teamId: string) => `/api/v1/teams/${teamId}/service-principals`;
const listKey = (teamId: string) => ['service-principals', teamId] as const;
const tokensKey = (teamId: string, id: string) => ['service-principal-tokens', teamId, id] as const;

export function useServicePrincipals(teamId: string) {
  return useQuery({
    enabled: !!teamId,
    queryFn: () => api.get<{ data: ServicePrincipalSummary[] }>(base(teamId)).then((r) => r.data),
    queryKey: listKey(teamId),
  });
}

export function useCreateServicePrincipal(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ServicePrincipalInput) =>
      api.post<{ data: ServicePrincipalSummary }>(base(teamId), body),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(teamId) }),
  });
}

export function useUpdateServicePrincipal(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: { id: string } & Partial<ServicePrincipalInput> & { disabled?: boolean }) =>
      api.patch<{ data: ServicePrincipalSummary }>(`${base(teamId)}/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(teamId) }),
  });
}

export function useDeleteServicePrincipal(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${base(teamId)}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(teamId) }),
  });
}

export function useServiceTokens(teamId: string, id: string | null) {
  return useQuery({
    enabled: !!teamId && !!id,
    queryFn: () =>
      api.get<{ data: ServiceTokenSummary[] }>(`${base(teamId)}/${id}/tokens`).then((r) => r.data),
    queryKey: tokensKey(teamId, id ?? ''),
  });
}

export function useCreateServiceToken(teamId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; expiresInDays: number; scopes: ServiceTokenScope[] }) =>
      api.post<{ data: ServiceTokenCreated }>(`${base(teamId)}/${id}/tokens`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: tokensKey(teamId, id) });
      void qc.invalidateQueries({ queryKey: listKey(teamId) });
    },
  });
}

export function useRevokeServiceToken(teamId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => api.delete(`${base(teamId)}/${id}/tokens/${tokenId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: tokensKey(teamId, id) });
      void qc.invalidateQueries({ queryKey: listKey(teamId) });
    },
  });
}
