'use client';

import type {
  HarnessProfileDetail,
  HarnessProfilePreview,
  HarnessProfileSource,
  HarnessProfileStatus,
  HarnessProfileSummary,
  HarnessProfileVersionDto,
} from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Harness profiles (`/api/v1/platform/harness-profiles`, ADMIN-only). Every string that came from
 * the repository (names, descriptions, paths, warnings, file text) is untrusted: render it through
 * `visibleText`. Nothing here writes until a create or accept, which names the previewed commit and
 * the preview's `contentHash` and `warningsHash`.
 */

export type {
  HarnessProfileDetail,
  HarnessProfilePreview,
  HarnessProfileSource,
  HarnessProfileStatus,
  HarnessProfileSummary,
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
    mutationFn: (body: HarnessProfileLocation & ApprovalInput) =>
      api.post<{ data: HarnessProfileDetail }>(BASE, body).then((r) => r.data),
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
    mutationFn: ({ name, ...body }: ApprovalInput & { name: string }) =>
      api
        .post<{ data: HarnessProfileVersionDto }>(`${nameUrl(name)}/accept`, body)
        .then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function usePatchProfile() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ name, status }: { name: string; status: HarnessProfileStatus }) =>
      api.patch<{ data: HarnessProfileSummary }>(nameUrl(name), { status }).then((r) => r.data),
    onSuccess: invalidate,
  });
}
