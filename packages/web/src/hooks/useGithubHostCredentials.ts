'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The platform GitHub credentials of one host other than the instance's: a PAT,
 * a GitHub App, or both. Secrets are write-only: the API reports only whether
 * each is set and its last four characters.
 */
export interface GithubHostCredentialRow {
  id: string;
  /** Lowercase `host[:port]` of the host family (`github.com`, `acme.ghe.com`, `ghe.corp`). */
  host: string;
  hasToken: boolean;
  tokenLastFour: string | null;
  appId: string | null;
  hasAppPrivateKey: boolean;
  appPrivateKeyLastFour: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGithubHostCredentialBody {
  host: string;
  token?: string;
  appId?: string;
  appPrivateKey?: string;
}

/** A field left out is unchanged; `null` clears it. */
export interface UpdateGithubHostCredentialBody {
  token?: string | null;
  appId?: string | null;
  appPrivateKey?: string | null;
}

const BASE = '/api/v1/platform/github-host-credentials';
const KEY = ['admin-github-host-credentials'];

export function useGithubHostCredentials() {
  return useQuery({
    queryFn: () => api.get<{ data: GithubHostCredentialRow[] }>(BASE).then((r) => r.data),
    queryKey: KEY,
  });
}

export function useCreateGithubHostCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateGithubHostCredentialBody) =>
      api.post<{ data: GithubHostCredentialRow }>(BASE, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateGithubHostCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateGithubHostCredentialBody }) =>
      api.patch<{ data: GithubHostCredentialRow }>(`${BASE}/${id}`, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteGithubHostCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
