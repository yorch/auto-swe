'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** A row in the installed-bundle registry (P4/WS3). */
export interface InstalledBundleRow {
  name: string;
  version: string;
  source: string | null;
  trustState: string;
  signedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const BASE = '/api/v1/platform/bundles';
const KEY = ['admin-bundles'];

export function useInstalledBundles() {
  return useQuery({
    queryFn: () => api.get<{ data: InstalledBundleRow[] }>(BASE).then((r) => r.data),
    queryKey: KEY,
  });
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

export interface BundleInstallResult {
  counts: { agents: number; skills: number; scannerPatterns: number; templates: number };
  trustState: 'VERIFIED' | 'UNVERIFIED';
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
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useExportBundle() {
  return useMutation({
    mutationFn: (body: { name: string; version: string; origin?: string }) =>
      api.post<{ data: unknown }>(`${BASE}/export`, body).then((r) => r.data),
  });
}
