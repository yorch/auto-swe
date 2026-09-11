'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * A GitHub App installation — where the App is installed, as opposed to the
 * App's own credentials, which are instance-wide and live on the GitHub
 * integration page.
 *
 * A deployment needs one row per GitHub organization it reaches. Repositories
 * point at one through `installationId`; a repository with none uses the
 * installation configured on the GitHub integration page.
 */
export interface GithubInstallationRow {
  id: string;
  /** GitHub's numeric installation id, as a string. */
  installationId: string;
  /** The organization or user the App is installed on. Display only. */
  accountLogin: string;
  isActive: boolean;
  createdAt?: string;
  _count?: { connections: number };
}

export interface CreateGithubInstallationBody {
  installationId: string;
  accountLogin: string;
  isActive?: boolean;
}

export interface UpdateGithubInstallationBody {
  accountLogin?: string;
  isActive?: boolean;
}

const BASE = '/api/v1/platform/github-installations';
const KEY = ['admin-github-installations'];

export function useGithubInstallations() {
  return useQuery({
    queryFn: () => api.get<{ data: GithubInstallationRow[] }>(BASE).then((r) => r.data),
    queryKey: KEY,
  });
}

export function useCreateGithubInstallation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateGithubInstallationBody) =>
      api.post<{ data: GithubInstallationRow }>(BASE, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateGithubInstallation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateGithubInstallationBody }) =>
      api.patch<{ data: GithubInstallationRow }>(`${BASE}/${id}`, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteGithubInstallation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
