'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The GitHub approver App: a second App identity whose only job is approving pull requests the
 * platform opened. The private key is write-only: the API reports only its last four characters.
 */
export interface GithubApproverApp {
  appId: string | null;
  appSlug: string | null;
  configured: boolean;
  privateKeyLastFour: string | null;
  /** Slugs of Apps this one replaced, oldest first; their approvals are still recognised and withdrawn. */
  retiredAppSlugs: string[];
  updatedAt: string | null;
}

/** A field left out is unchanged; a blank `privateKey` keeps the stored one. */
export interface SaveGithubApproverAppBody {
  appId?: string | null;
  appSlug?: string | null;
  privateKey?: string;
}

const PATH = '/api/v1/integrations/github-approver-app';
const KEY = ['admin-github-approver-app'];

export function useGithubApproverApp() {
  return useQuery({
    queryFn: () => api.get<GithubApproverApp>(PATH),
    queryKey: KEY,
  });
}

export function useSaveGithubApproverApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveGithubApproverAppBody) => api.put<GithubApproverApp>(PATH, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRemoveGithubApproverApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(PATH),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export const GITHUB_APPROVER_APP_TEST_PATH = `${PATH}/test`;
