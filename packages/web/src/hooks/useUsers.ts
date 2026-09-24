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

/** The full directory — `GET /users` is ADMIN-only, so pass `enabled: false` otherwise. */
export function useUsers(enabled = true) {
  return useQuery({
    enabled,
    queryFn: () => api.get<{ data: UserSummary[] }>('/api/v1/users').then((r) => r.data),
    queryKey: ['users'],
  });
}

/**
 * Active users who aren't already members of the scope being edited — the
 * candidate list for an "add member" picker. Shared by the teams AddMemberModal
 * and the org admin page so the eligibility rule lives in one place. Only an
 * ADMIN can list the directory; other callers get `[]` and should use
 * `lookupUserByEmail` instead.
 */
export function useEligibleUsers(existingUserIds: string[], enabled = true): UserSummary[] {
  const { data: users = [] } = useUsers(enabled);
  const existing = new Set(existingUserIds);
  return users.filter((u) => u.isActive && !existing.has(u.id));
}

/** Only identity: the lookup deliberately reveals no platform role. */
export interface LookedUpUser {
  id: string;
  email: string;
  name: string | null;
}

/** Resolve one active user by exact email (`GET /users/lookup`, LEAD+). */
export function lookupUserByEmail(email: string): Promise<LookedUpUser> {
  return api
    .get<{ data: LookedUpUser }>(`/api/v1/users/lookup?email=${encodeURIComponent(email)}`)
    .then((r) => r.data);
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
