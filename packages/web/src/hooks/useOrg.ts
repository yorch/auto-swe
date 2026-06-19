'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type OrgRole = 'ORG_ADMIN' | 'ORG_MEMBER';

export interface OrgMemberRow {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  createdAt: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
  };
}

export interface OrgBudgetRow {
  orgId: string;
  orgName: string;
  monthlyBudgetUsdCents: number | null;
  currentMonthUsage: {
    yearMonth: string;
    costUsdAccrued: number;
    runsCompleted: number;
    tokensInput: number;
    tokensOutput: number;
  } | null;
}

// ── Org Members ──

export function useOrgMembers(orgId: string) {
  return useQuery({
    enabled: !!orgId,
    queryFn: () => api.get<OrgMemberRow[]>(`/api/v1/admin/organizations/${orgId}/members`),
    queryKey: ['org-members', orgId],
  });
}

export function useUpsertOrgMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { userId: string; role: OrgRole }) =>
      api.post<OrgMemberRow>(`/api/v1/admin/organizations/${orgId}/members`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-members', orgId] }),
  });
}

export function usePatchOrgMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrgRole }) =>
      api.patch<OrgMemberRow>(`/api/v1/admin/organizations/${orgId}/members/${userId}`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-members', orgId] }),
  });
}

export function useRemoveOrgMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api.delete(`/api/v1/admin/organizations/${orgId}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-members', orgId] }),
  });
}

// ── Org Budget ──

export function useOrgBudget(orgId: string) {
  return useQuery({
    enabled: !!orgId,
    queryFn: () => api.get<OrgBudgetRow>(`/api/v1/admin/organizations/${orgId}/budget`),
    queryKey: ['org-budget', orgId],
  });
}

export function usePatchOrgBudget(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (monthlyBudgetUsdCents: number | null) =>
      api.patch<{ id: string; monthlyBudgetUsdCents: number | null; name: string }>(
        `/api/v1/admin/organizations/${orgId}/budget`,
        { monthlyBudgetUsdCents }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-budget', orgId] }),
  });
}
