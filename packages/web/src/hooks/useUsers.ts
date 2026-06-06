'use client';

import type { UserSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface CreateUserBody {
  email: string;
  /** Omit to let the gateway auto-generate one (returned once in the response). */
  password?: string;
  role?: 'ADMIN' | 'LEAD' | 'ENGINEER';
  slackId?: string;
}

export interface CreatedUser extends UserSummary {
  /** Only present when password was auto-generated. Shown to the admin once. */
  temporaryPassword?: string;
}

export function useUsers() {
  return useQuery({
    queryFn: () => api.get<{ data: UserSummary[] }>('/api/v1/users').then((r) => r.data),
    queryKey: ['users'],
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<{
        isActive: boolean;
        role: 'ADMIN' | 'LEAD' | 'ENGINEER';
        slackId: string | null;
      }>;
    }) => api.patch<{ data: UserSummary }>(`/api/v1/users/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role?: 'ADMIN' | 'LEAD' | 'ENGINEER' }) =>
      api.post<{ data: UserSummary }>('/api/v1/users/invite', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserBody) => api.post<{ data: CreatedUser }>('/api/v1/users', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}
