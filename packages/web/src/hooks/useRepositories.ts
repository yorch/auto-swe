'use client';

import type { PreviewConfig } from '@auto-swe/shared/lib/previewConfig';
import type { RepoSetup } from '@auto-swe/shared/lib/repoSetup';
import type {
  RepoGateCommands,
  RepoSetupBlockersResponse,
  RepoSetupFileProposalStatus,
  RepoSetupSecretSummary,
  RepositorySummary,
} from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { type ListOptions, listUrl, useListQuery } from '@/hooks/useListQuery';
import { READINESS_KEY } from '@/hooks/useReadiness';
import { api } from '@/lib/api';

export interface RepoOnboardingRun {
  workflowId: string | null;
  temporalWorkflowId: string;
  workRequestId: string;
  runId: string | null;
  deduplicated: boolean;
}

export function useRunRepoOnboarding() {
  const keys = useRef(new Map<string, string>());
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const key = keys.current.get(connectionId) ?? crypto.randomUUID();
      keys.current.set(connectionId, key);
      return (
        await api.fetch<{ data: RepoOnboardingRun }>(
          `/api/v1/repositories/${connectionId}/onboarding-runs`,
          { body: '{}', headers: { 'Idempotency-Key': key }, method: 'POST' }
        )
      ).data;
    },
    onSuccess: (_, connectionId) => {
      keys.current.delete(connectionId);
      void queryClient.invalidateQueries({ queryKey: ['workflow-runs'] });
      void queryClient.invalidateQueries({ queryKey: ['work-requests'] });
    },
  });
}

export interface GitHubRepoInfo {
  installationId: string | null;
  installationAccount: string | null;
  githubUrl: string | null;
  githubApiUrl: string | null;
  access: 'readable' | 'unchecked';
  org: string;
  name: string;
  description: string | null;
  language: string | null;
  defaultBranch: string;
  htmlUrl: string;
  apiUrl: string;
  alreadyImported: boolean;
}

export interface CreateRepoBody {
  organizationName: string;
  repoName: string;
  defaultBranch?: string;
  teamId: string;
  executorImage?: string;
  /** Onboard with these; any at all takes team ADMIN. */
  gateCommands?: RepoGateCommands;
  previewConfig?: PreviewConfig;
  setup?: RepoSetup;
  language?: string;
  description?: string;
  githubUrl?: string;
  githubApiUrl?: string;
}

export interface CreateConnectionBody {
  type: string;
  name?: string;
  teamId: string;
  description?: string;
  config?: unknown;
  /** Write-only; stored encrypted. */
  apiToken?: string;
  // git_repo only
  organizationName?: string;
  repoName?: string;
  defaultBranch?: string;
  executorImage?: string;
  language?: string;
}

export interface UpdateRepoBody {
  consolidationEnabled?: boolean;
  defaultBranch?: string;
  description?: string | null;
  executorImage?: string | null;
  /** Replaces the stored set; leave out to keep it. Changing it needs team ADMIN. */
  gateCommands?: RepoGateCommands | null;
  previewConfig?: PreviewConfig | null;
  setup?: RepoSetup | null;
  prTitleFormat?: 'template' | 'conventional' | null;
  prTitleTemplate?: string | null;
  isActive?: boolean;
  language?: string | null;
  teamId?: string;
  githubUrl?: string | null;
  githubApiUrl?: string | null;
  name?: string | null;
  config?: unknown;
  /** A new write-only token; leave out to keep the stored one. */
  apiToken?: string;
}

export function useRepositories(
  opts: ListOptions & { includeInactive?: boolean; q?: string } = {}
) {
  const { includeInactive, q, ...page } = opts;
  const filters = new URLSearchParams();
  if (includeInactive) {
    filters.set('includeInactive', 'true');
  }
  if (q) {
    filters.set('q', q);
  }
  const path = `/api/v1/repositories${filters.size ? `?${filters.toString()}` : ''}`;
  return useListQuery<RepositorySummary>({
    queryFn: () => api.get(listUrl(path, page)),
    queryKey: ['repositories', opts],
  });
}

export function useCreateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRepoBody | CreateConnectionBody) =>
      api.post<{ data: RepositorySummary }>('/api/v1/repositories', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['repositories'] });
      // Setup readiness counts active repository connections.
      qc.invalidateQueries({ queryKey: READINESS_KEY });
    },
  });
}

export function useUpdateRepository(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateRepoBody) =>
      api.patch<{ data: RepositorySummary }>(`/api/v1/repositories/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['repositories'] });
      // Setup readiness counts active repository connections.
      qc.invalidateQueries({ queryKey: READINESS_KEY });
    },
  });
}

export interface ShareTeam {
  id: string;
  name: string;
  slug: string;
}

/** Teams a repository could be shared with — its organization's, minus the owner. */
export function useShareCandidates(repoId: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryFn: () =>
      api
        .get<{ data: ShareTeam[] }>(`/api/v1/repositories/${repoId}/share-candidates`)
        .then((r) => r.data),
    queryKey: ['repo-share-candidates', repoId],
  });
}

/** Replace the set of teams a repository is shared with. */
export function useSetRepoShares(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (teamIds: string[]) =>
      api.put<{ data: Array<{ team: ShareTeam }> }>(`/api/v1/repositories/${repoId}/shares`, {
        teamIds,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}

/** Allow or stop one sharee team launching work on a repository (`canLaunch`); the owner's call. */
export function useSetRepoShareLaunch(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ canLaunch, teamId }: { canLaunch: boolean; teamId: string }) =>
      api.patch<{ data: unknown }>(`/api/v1/repositories/${repoId}/shares/${teamId}`, {
        canLaunch,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}

export interface MyCredential {
  connectionId: string;
  lastFour: string;
  createdAt: string;
  updatedAt: string;
}

export interface MyCredentials {
  /** Whether an admin has turned per-user credentials on. */
  enabled: boolean;
  /** Hosts a saved token may be sent to — returned to platform admins only. */
  hosts?: string[];
  credentials: MyCredential[];
}

/** The caller's own saved GitHub tokens (metadata only) and the policy. */
export function useMyCredentials() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: MyCredentials }>('/api/v1/repositories/credentials/mine').then((r) => r.data),
    queryKey: ['my-repo-credentials'],
  });
}

/**
 * Ask for a pull request adding `.auto-swe/setup.yml`, written from `setup`, to the repository.
 * Resolves to the request id at once; {@link useSetupFileProposalStatus} follows it.
 */
export function useProposeSetupFile(connectionId: string) {
  return useMutation({
    mutationFn: (setup: RepoSetup) =>
      api
        .post<{ data: { requestId: string } }>(
          `/api/v1/repositories/${connectionId}/setup/pull-request`,
          { setup }
        )
        .then((r) => r.data),
  });
}

/** Where a setup-file pull request stands; polled every two seconds while it is queued. */
export function useSetupFileProposalStatus(connectionId: string, requestId: string | null) {
  return useQuery({
    enabled: Boolean(connectionId && requestId),
    queryFn: () =>
      api
        .get<{ data: RepoSetupFileProposalStatus }>(
          `/api/v1/repositories/${connectionId}/setup/pull-request/${requestId}`
        )
        .then((r) => r.data),
    queryKey: ['repositories', connectionId, 'setup-file-request', requestId],
    refetchInterval: (query) => (query.state.data?.status === 'queued' ? 2_000 : false),
  });
}

export function useSaveMyCredential(connectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      api.put<{ data: MyCredential & { permission: string } }>(
        `/api/v1/repositories/${connectionId}/credential`,
        { token }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-repo-credentials'] }),
  });
}

export function useDeleteMyCredential(connectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`/api/v1/repositories/${connectionId}/credential`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-repo-credentials'] }),
  });
}

export function useGitHubAvailableRepos(enabled = false) {
  return useQuery({
    enabled,
    queryFn: () =>
      api.get<{ data: GitHubRepoInfo[]; sources: GitHubImportSource[] }>(
        '/api/v1/repositories/github/available'
      ),
    queryKey: ['github-available-repos'],
    staleTime: 30_000,
  });
}

export interface GitHubImportSource {
  installationId: string | null;
  installationAccount: string | null;
  githubUrl: string;
  error?: string;
}
export interface GitHubImportResult {
  organizationName: string;
  repoName: string;
  status: 'created' | 'failed';
  id?: string;
  code?: string;
  message?: string;
}
export function useImportGitHubRepos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      teamId: string;
      repos: {
        organizationName: string;
        repoName: string;
        installationId: string | null;
        defaultBranch?: string;
      }[];
    }) =>
      api
        .post<{ data: GitHubImportResult[] }>('/api/v1/repositories/import', body)
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['repositories'] });
      qc.invalidateQueries({ queryKey: ['github-available-repos'] });
      qc.invalidateQueries({ queryKey: READINESS_KEY });
    },
  });
}

export function useSetupBlockers(
  connectionId: string,
  options: { includeResolved?: boolean } = {}
) {
  const includeResolved = options.includeResolved ?? false;
  return useQuery({
    queryFn: () =>
      api
        .get<RepoSetupBlockersResponse>(
          `/api/v1/repositories/${connectionId}/setup-blockers${includeResolved ? '?includeResolved=true' : ''}`
        )
        .then((r) => r.blockers),
    queryKey: ['repositories', connectionId, 'setup-blockers', includeResolved],
    ...(includeResolved ? { retry: false } : {}),
  });
}

export function useWorkflowSetupBlocker(connectionId: string, workflowId: string) {
  const query = useSetupBlockers(connectionId, { includeResolved: true });
  return query.isError ? undefined : query.data?.find((row) => row.lastWorkflowId === workflowId);
}

export function useDismissSetupBlocker(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (blockerId: string) =>
      api.post(
        `/api/v1/repositories/${connectionId}/setup-blockers/${encodeURIComponent(blockerId)}/resolve`,
        {}
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['repositories', connectionId, 'setup-blockers'] }),
  });
}

/** The repository's setup secrets: names and last four characters, never values. */
export function useSetupSecrets(connectionId: string | undefined) {
  return useQuery({
    enabled: Boolean(connectionId),
    queryFn: () =>
      api
        .get<{ data: RepoSetupSecretSummary[] }>(
          `/api/v1/repositories/${connectionId}/setup/secrets`
        )
        .then((r) => r.data),
    queryKey: ['repositories', connectionId, 'setup-secrets'],
  });
}

export function useSaveSetupSecret(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      api.put<{ data: RepoSetupSecretSummary }>(
        `/api/v1/repositories/${connectionId}/setup/secrets/${encodeURIComponent(name)}`,
        { value }
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['repositories', connectionId, 'setup-secrets'] }),
  });
}

/** Move app preview recipe env values (by default the secret-looking ones) into setup secrets. */
export function useMovePreviewEnvToSecrets(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (names?: string[]) =>
      api
        .post<{ data: { moved: string[]; previewConfig: unknown } }>(
          `/api/v1/repositories/${connectionId}/preview/env-to-secrets`,
          names ? { names } : {}
        )
        .then((r) => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['repositories'] }),
  });
}

export function useDeleteSetupSecret(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.delete(`/api/v1/repositories/${connectionId}/setup/secrets/${encodeURIComponent(name)}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['repositories', connectionId, 'setup-secrets'] }),
  });
}

/** One of the repository team's eval datasets, and whether it reads this repository's secrets. */
export interface RepoEvalDatasetLink {
  id: string;
  name: string;
  slug: string;
  /** TEAM for the repository team's datasets, ORGANIZATION for its organization's. */
  scope: 'TEAM' | 'ORGANIZATION';
  linked: boolean;
  /** The other repository the dataset reads setup secrets from, if any. */
  usesRepository: { id: string; name: string } | null;
}

export function useRepoEvalDatasets(connectionId: string | undefined) {
  return useQuery({
    enabled: Boolean(connectionId),
    queryFn: () =>
      api
        .get<{ data: RepoEvalDatasetLink[] }>(
          `/api/v1/repositories/${connectionId}/setup/eval-datasets`
        )
        .then((r) => r.data),
    queryKey: ['repositories', connectionId, 'eval-datasets'],
  });
}

export function useLinkRepoEvalDataset(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ datasetId, linked }: { datasetId: string; linked: boolean }) =>
      api.put<{ data: { linked: boolean } }>(
        `/api/v1/repositories/${connectionId}/setup/eval-datasets/${datasetId}`,
        { linked }
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['repositories', connectionId, 'eval-datasets'] }),
  });
}
