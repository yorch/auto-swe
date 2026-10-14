'use client';

import type { BundleInstallResult, InstalledBundleRow } from '@auto-swe/shared/bundle';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type { BundleInstallResult, InstalledBundleRow };

const BASE = '/api/v1/platform/bundles';
const KEY = ['admin-bundles'];

/**
 * Everything an install can change: the registry itself and the agents, skills, workflow
 * templates and scanner patterns the bundle wrote, each under every key it is cached as.
 */
const INSTALLED_CONTENT_KEYS = [
  KEY,
  ['admin-agent-library'],
  ['team-agent-library'],
  ['team-agent-options'],
  ['agent-run-agents'],
  ['skills'],
  ['workflow-templates'],
  ['scanner-patterns'],
];

function invalidateInstalledContent(qc: QueryClient) {
  for (const queryKey of INSTALLED_CONTENT_KEYS) {
    qc.invalidateQueries({ queryKey });
  }
}

export function useInstalledBundles() {
  return useQuery({
    queryFn: () => api.get<{ data: InstalledBundleRow[] }>(BASE).then((r) => r.data),
    queryKey: KEY,
  });
}

/** The server's bundle size cap in bytes, or null while it is loading or unavailable. */
export function useBundleMaxBytes(): number | null {
  const { data } = useQuery({
    queryFn: () =>
      api.get<{ data: { maxBytes: number } }>(`${BASE}/limits`).then((r) => r.data.maxBytes),
    queryKey: [...KEY, 'limits'],
    staleTime: 5 * 60_000,
  });
  return data ?? null;
}

/** What installing one bundle entry would do to the library. */
export interface BundlePreviewEntry {
  action: 'create' | 'replace';
  name: string;
  /** The row it replaces is a built-in or admin-authored one. */
  protected: boolean;
  type?: string;
}

/** What `POST /bundles/preview` returns: the checks an install makes, and its effect. */
export interface BundlePreview {
  blockedReason: string | null;
  contentHash: string;
  entities: {
    agents: BundlePreviewEntry[];
    scannerPatterns: BundlePreviewEntry[];
    skills: BundlePreviewEntry[];
    templates: BundlePreviewEntry[];
  };
  installedVersion: string | null;
  name: string;
  signedBy: string | null;
  source: string | null;
  trustState: 'VERIFIED' | 'UNVERIFIED';
  version: string;
  warnings: string[];
}

export function usePreviewBundle() {
  return useMutation({
    mutationFn: (source: { url: string } | { bundle: unknown }) =>
      api.post<{ data: BundlePreview }>(`${BASE}/preview`, source).then((r) => r.data),
  });
}

export function useInstallBundleFromUrl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { url: string; expectedContentHash: string; overwriteProtected: boolean }) =>
      api.post<{ data: BundleInstallResult }>(`${BASE}/install-from-url`, body).then((r) => r.data),
    onSuccess: () => invalidateInstalledContent(qc),
  });
}

/** Install a bundle read from a local file, against the content hash the admin previewed. */
export function useInstallBundleFromFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      bundle: unknown;
      expectedContentHash: string;
      overwriteProtected: boolean;
    }) => api.post<{ data: BundleInstallResult }>(`${BASE}/install`, body).then((r) => r.data),
    onSuccess: () => invalidateInstalledContent(qc),
  });
}

export function useExportBundle() {
  return useMutation({
    mutationFn: (body: { name: string; version: string; origin?: string }) =>
      api.post<{ data: unknown }>(`${BASE}/export`, body).then((r) => r.data),
  });
}
