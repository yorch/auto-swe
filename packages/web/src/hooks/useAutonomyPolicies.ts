import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface AutonomyPolicy {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  rules: Record<string, { action: 'auto' | 'require_approval'; approverCount?: number }>;
  teamId: string | null;
  team: { id: string; name: string; slug: string } | null;
  templateId: string | null;
  template: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutonomyPolicyForm {
  description?: string;
  isDefault?: boolean;
  name: string;
  rules: Record<string, { action: 'auto' | 'require_approval'; approverCount?: number }>;
  teamId?: string | null;
  templateId?: string | null;
}

export function useAutonomyPolicies() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: AutonomyPolicy[] }>('/api/v1/platform/autonomy-policies').then((r) => r.data),
    queryKey: ['autonomy-policies'],
  });
}

export function useCreateAutonomyPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AutonomyPolicyForm) =>
      api
        .post<{ data: AutonomyPolicy }>('/api/v1/platform/autonomy-policies', body)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['autonomy-policies'] }),
  });
}

export function useUpdateAutonomyPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: AutonomyPolicyForm & { id: string }) =>
      api
        .patch<{ data: AutonomyPolicy }>(`/api/v1/platform/autonomy-policies/${id}`, body)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['autonomy-policies'] }),
  });
}

export function useDeleteAutonomyPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/platform/autonomy-policies/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['autonomy-policies'] }),
  });
}
