'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The webhook secret of one GitHub Enterprise host. The secret itself is
 * write-only: the API reports only its last four characters.
 */
export interface GithubWebhookSecretRow {
  id: string;
  /** Lowercase `host[:port]`, as `X-GitHub-Enterprise-Host` spells it. */
  host: string;
  lastFour: string;
  createdAt: string;
  updatedAt: string;
}

const BASE = '/api/v1/platform/github-webhook-secrets';
const KEY = ['admin-github-webhook-secrets'];

export function useGithubWebhookSecrets() {
  return useQuery({
    queryFn: () => api.get<{ data: GithubWebhookSecretRow[] }>(BASE).then((r) => r.data),
    queryKey: KEY,
  });
}

export function useCreateGithubWebhookSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { host: string; secret: string }) =>
      api.post<{ data: GithubWebhookSecretRow }>(BASE, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRotateGithubWebhookSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, secret }: { id: string; secret: string }) =>
      api.patch<{ data: GithubWebhookSecretRow }>(`${BASE}/${id}`, { secret }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteGithubWebhookSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
