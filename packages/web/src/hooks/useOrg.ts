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
  budgetAlertThresholdPercent: number | null;
  currentMonthUsage: {
    yearMonth: string;
    costUsdAccrued: number;
    runsCompleted: number;
    tokensInput: number;
    tokensOutput: number;
  } | null;
}

// ── Org Members ──

export interface OrgRow {
  budgetAlertThresholdPercent: number | null;
  id: string;
  monthlyBudgetUsdCents: number | null;
  name: string;
  slug: string;
}

export function useOrg(orgId: string) {
  return useQuery({
    enabled: !!orgId,
    queryFn: () =>
      api.get<{ data: OrgRow }>(`/api/v1/admin/organizations/${orgId}`).then((r) => r.data),
    queryKey: ['org', orgId],
  });
}

export function usePatchOrg(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; slug?: string }) =>
      api.patch<{ data: OrgRow }>(`/api/v1/admin/organizations/${orgId}`, body).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org', orgId] });
      qc.invalidateQueries({ queryKey: ['user-orgs'] });
    },
  });
}

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

export interface BudgetAlertOrg {
  alert: { percent: number | null; triggered: boolean };
  budgetAlertThresholdPercent: number | null;
  currentMonthUsage: {
    costUsdAccrued: number;
    runsCompleted: number;
    yearMonth: string;
  } | null;
  id: string;
  monthlyBudgetUsdCents: number | null;
  name: string;
  slug: string;
}

export function useBudgetAlerts() {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: BudgetAlertOrg[] }>('/api/v1/admin/organizations/budget-alerts')
        .then((r) => r.data),
    queryKey: ['budget-alerts'],
    refetchInterval: 30_000,
  });
}

export function useInviteOrgMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; orgRole: OrgRole }) =>
      api.post<OrgMemberRow>(`/api/v1/admin/organizations/${orgId}/members/invite`, body),
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

export interface PatchOrgBudgetBody {
  monthlyBudgetUsdCents: number | null;
  budgetAlertThresholdPercent: number | null;
}

export function usePatchOrgBudget(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchOrgBudgetBody) =>
      api.patch<{
        budgetAlertThresholdPercent: number | null;
        id: string;
        monthlyBudgetUsdCents: number | null;
        name: string;
      }>(`/api/v1/admin/organizations/${orgId}/budget`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-budget', orgId] });
      qc.invalidateQueries({ queryKey: ['org', orgId] });
      qc.invalidateQueries({ queryKey: ['user-orgs'] });
    },
  });
}
