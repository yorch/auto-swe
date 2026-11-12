'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GithubInstallationRow } from '@/hooks/useGithubInstallations';
import { api } from '@/lib/api';

export function useOrganizationGithub(orgId: string) {
  const qc = useQueryClient();
  const base = `/api/v1/organizations/${orgId}/github`;
  const key = ['organization-github', orgId];
  const installations = useQuery({
    queryFn: () =>
      api.get<{ data: GithubInstallationRow[] }>(`${base}/installations`).then((r) => r.data),
    queryKey: key,
  });
  const connect = useMutation({
    mutationFn: () =>
      api.post<{ data: { url: string } }>(`${base}/connect`, {}).then((r) => r.data),
  });
  const retire = useMutation({
    mutationFn: (id: string) => api.post(`${base}/installations/${id}/retire`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  return { connect, installations, retire };
}

export function useClaimGithubInstallation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code: string; installation_id: string; state: string }) =>
      api
        .post<{ data: GithubInstallationRow }>('/api/v1/organizations/github/claim', body)
        .then((r) => r.data),
    onSuccess: (row) =>
      qc.invalidateQueries({ queryKey: ['organization-github', row.organizationId] }),
  });
}
