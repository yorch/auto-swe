'use client';

import type {
  HarnessProfileBoundAgent,
  HarnessProfileDetail,
  HarnessProfileHookChanges,
  HarnessProfileHookSource,
  HarnessProfilePreview,
  HarnessProfileProjectionWarnings,
  HarnessProfileSource,
  HarnessProfileStatus,
  HarnessProfileSummary,
  HarnessProfileTrackStatus,
  HarnessProfileVersionDto,
} from '@auto-swe/shared/types/api';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Harness profiles (`/api/v1/platform/harness-profiles`, ADMIN-only). Every string that came from
 * the repository (names, descriptions, paths, warnings, file text) is untrusted: render it through
 * `visibleText`. Nothing here writes until a create or accept, which names the previewed commit and
 * the preview's `contentHash` and `warningsHash`.
 */

export type {
  HarnessProfileBoundAgent,
  HarnessProfileDetail,
  HarnessProfileHookChanges,
  HarnessProfileHookSource,
  HarnessProfilePreview,
  HarnessProfileProjectionWarnings,
  HarnessProfileSource,
  HarnessProfileStatus,
  HarnessProfileSummary,
  HarnessProfileTrackStatus,
  HarnessProfileVersionDto,
};

/** One file's text from a review request. `text` is null for a binary file. */
export interface ReviewedFile {
  path: string;
  size: number;
  mode: string;
  binary: boolean;
  text: string | null;
  truncated: boolean;
}

export type HarnessProfileLocation = HarnessProfileSource;

/** What a create or accept sends beside the previewed commit. */
export interface ApprovalInput {
  sha: string;
  contentHash: string;
  warningsHash: string;
  acknowledgeWarnings: boolean;
}

/** Creating a profile asks for the hook switch outright: there is no server-side default. */
export interface CreateProfileInput extends ApprovalInput {
  hooksEnabled: boolean;
}

/** Plugin skills written (or refused) as a side effect of an approval; never undoes it. */
export type ProjectionResult = HarnessProfileProjectionWarnings;

export interface CreateProfileResult {
  data: HarnessProfileDetail;
  projection: ProjectionResult | null;
}

export interface AcceptProfileResult {
  data: HarnessProfileVersionDto;
  projection: ProjectionResult | null;
}

/** One team that enabled the plugin. */
export interface ProfileEnablement {
  teamId: string;
  teamName: string;
  teamSlug: string;
  enabledAt: string;
  enabledById: string | null;
}

/** What `POST /:name/check` answers; `recorded` is false when the row changed meanwhile. */
export interface ProfileCheckResult {
  check: { status: HarnessProfileTrackStatus | 'SKIPPED'; error: string | null };
  recorded: boolean;
  profile: HarnessProfileSummary | null;
}

const BASE = '/api/v1/platform/harness-profiles';
const KEY = ['harness-profiles'];
const nameUrl = (name: string) => `${BASE}/${encodeURIComponent(name)}`;

export function useHarnessProfiles(enabled = true) {
  return useQuery({
    enabled,
    queryFn: () => api.get<{ data: HarnessProfileSummary[] }>(BASE).then((r) => r.data),
    queryKey: KEY,
  });
}

export function useHarnessProfile(name: string | null) {
  return useQuery({
    enabled: name !== null,
    queryFn: () =>
      api.get<{ data: HarnessProfileDetail }>(nameUrl(name as string)).then((r) => r.data),
    queryKey: [...KEY, 'detail', name],
  });
}

/**
 * The list answers neither the enabled-team count nor the stranded agents, so the list view reads
 * each profile's detail (the same cache entries the detail dialog uses). A profile whose detail
 * has not loaded maps to nothing.
 */
export function useProfileUsage(names: string[]) {
  const results = useQueries({
    queries: names.map((name) => ({
      queryFn: () => api.get<{ data: HarnessProfileDetail }>(nameUrl(name)).then((r) => r.data),
      queryKey: [...KEY, 'detail', name],
    })),
  });
  const usage = new Map<string, { enabledTeams: number; stranded: number }>();
  results.forEach((r, i) => {
    const d = r.data;
    if (d) {
      usage.set(names[i] as string, {
        enabledTeams: d.enabledTeams ?? 0,
        stranded: (d.boundAgents ?? []).filter((a) => a.stranded).length,
      });
    }
  });
  return usage;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

/** Reads, validates and scans a folder at a ref; writes nothing. */
export function usePreviewProfile() {
  return useMutation({
    mutationFn: (body: HarnessProfileLocation) =>
      api.post<{ data: HarnessProfilePreview }>(`${BASE}/preview`, body).then((r) => r.data),
  });
}

/** One file's text from the commit a preview showed. */
export function useReviewProfileFile() {
  return useMutation({
    mutationFn: ({ file, sha, ...body }: HarnessProfileLocation & { file: string; sha: string }) =>
      api
        .post<{ data: ReviewedFile }>(`${BASE}/preview`, { ...body, file, sha })
        .then((r) => r.data),
  });
}

export function useCreateProfile() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: HarnessProfileLocation & CreateProfileInput) =>
      api
        .post<{ data: HarnessProfileDetail; projection?: ProjectionResult }>(BASE, body)
        .then((r): CreateProfileResult => ({ data: r.data, projection: r.projection ?? null })),
    onSuccess: invalidate,
  });
}

/** Reads the profile's stored source again (or the named commit); writes nothing. */
export function usePreviewProfileUpdate() {
  return useMutation({
    mutationFn: ({ name, sha }: { name: string; sha?: string }) =>
      api
        .post<{ data: HarnessProfilePreview }>(
          `${nameUrl(name)}/preview-update`,
          sha ? { sha } : {}
        )
        .then((r) => r.data),
  });
}

export function useReviewUpdateFile() {
  return useMutation({
    mutationFn: ({ name, file, sha }: { name: string; file: string; sha: string }) =>
      api
        .post<{ data: ReviewedFile }>(`${nameUrl(name)}/preview-update`, { file, sha })
        .then((r) => r.data),
  });
}

export function useAcceptProfileVersion() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      name,
      ...body
    }: ApprovalInput & { name: string; acknowledgeHookChanges?: boolean }) =>
      api
        .post<{ data: HarnessProfileVersionDto; projection?: ProjectionResult }>(
          `${nameUrl(name)}/accept`,
          body
        )
        .then((r): AcceptProfileResult => ({ data: r.data, projection: r.projection ?? null })),
    onSuccess: invalidate,
  });
}

export function usePatchProfile() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      name,
      ...body
    }: {
      name: string;
      status?: HarnessProfileStatus;
      /** Platform ADMIN only, either direction; needs no new version. */
      hooksEnabled?: boolean;
    }) => api.patch<{ data: HarnessProfileSummary }>(nameUrl(name), body).then((r) => r.data),
    onSuccess: invalidate,
  });
}

/** Resolves the ref now and records whether an update is waiting; writes no version. */
export function useCheckProfile() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ data: ProfileCheckResult }>(`${nameUrl(name)}/check`, {}).then((r) => r.data),
    onSuccess: invalidate,
  });
}

/** The teams that enabled the plugin. */
export function useProfileEnablements(name: string | null) {
  return useQuery({
    enabled: name !== null,
    queryFn: () =>
      api
        .get<{ data: ProfileEnablement[] }>(`${nameUrl(name as string)}/enablements`)
        .then((r) => r.data),
    queryKey: [...KEY, 'enablements', name],
  });
}
