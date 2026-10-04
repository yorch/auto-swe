'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * External skill sources (`/api/v1/platform/skill-sources`, ADMIN-only). Every
 * string that came from the repository (names, descriptions, folders, paths,
 * diff lines) is untrusted text: render it through `visibleText`.
 */

export type SourceStatus = 'OK' | 'UPDATE_AVAILABLE' | 'ERROR' | 'DISABLED';
export type ScriptMode = 'TEXT_ONLY' | 'REJECT';
export type SourceScopeKind = 'GLOBAL' | 'ORGANIZATION' | 'TEAM';

export interface SkillSource {
  id: string;
  host: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
  pinnedSha: string;
  latestSha: string | null;
  lastCheckedAt: string | null;
  /** A fixed server-side string, never repository text. */
  lastError: string | null;
  status: SourceStatus;
  scriptMode: ScriptMode;
  scope: SourceScopeKind;
  teamId: string | null;
  orgId: string | null;
  skillCount: number;
}

export interface SourceLocationInput {
  host: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
  scriptMode: ScriptMode;
  scope: SourceScopeKind;
  teamId?: string;
  orgId?: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface PreviewSkill {
  folder: string;
  name: string | null;
  description: string | null;
  textLength: number;
  referenceFileCount: number;
  ignoredKeys: string[];
  skippedFiles: SkippedFile[];
  scanWarnings: string[];
  conflicts: Array<{ id: string; name: string; scope: string }>;
  errors: string[];
  /** Refused only because `skills.import.blockOnScanWarnings` is on and it has warnings. */
  blockedByScan: boolean;
  installable: boolean;
}

export interface SourcePreview {
  sha: string;
  location: { host: string; owner: string; repo: string; path: string; ref: string };
  skills: PreviewSkill[];
}

export interface DiffChangedSkill {
  skillId: string;
  name: string;
  folder: string;
  installedRevision: number;
  renamedTo: string | null;
  description: { old: string | null; new: string | null; changed: boolean };
  textDiff: string;
  textDiffTruncated: boolean;
  diffTooLarge: boolean;
  diffIncomplete: boolean;
  textLength: { old: number; new: number };
  referenceFiles: { added: string[]; changed: string[]; removed: string[] };
  scanWarnings: string[];
  blockedByScan: boolean;
  handEdited: boolean;
  ignoredKeys: string[];
  skippedFiles: SkippedFile[];
}

export interface DiffAddedSkill {
  folder: string;
  /** Skills an install of this one would collide with by name. */
  conflicts: Array<{ id: string; name: string; scope: string }>;
  blockedByScan: boolean;
  name: string | null;
  description: string | null;
  textLength: number;
  referenceFileCount: number;
  ignoredKeys: string[];
  skippedFiles: SkippedFile[];
  scanWarnings: string[];
  errors: string[];
}

export interface SourceDiff {
  sha: string;
  source: { id: string; latestSha: string | null; pinnedSha: string; status: SourceStatus };
  changed: DiffChangedSkill[];
  unchanged: Array<{
    skillId: string;
    name: string;
    handEdited: boolean;
    renamedTo: string | null;
  }>;
  errors: Array<{ skillId: string; name: string; folder: string; errors: string[] }>;
  removed: Array<{ skillId: string; name: string; folder: string }>;
  added: DiffAddedSkill[];
}

export interface IncomingSkill {
  name: string | null;
  description: string | null;
  folder: string;
  errors: string[];
  promptText: string;
  referenceFiles: Array<{ path: string; length: number }>;
  sha: string;
}

export interface AcceptResult {
  sha: string;
  accepted: Array<{ id: string; name: string; fromRevision: number; revision: number }>;
  conflicts: string[];
  notSelected: string[];
  unreadable: string[];
  removed: string[];
  pinAdvanced: boolean;
  after: { pinnedSha: string; status: SourceStatus };
}

const BASE = '/api/v1/platform/skill-sources';

export function useSkillSources(enabled = true) {
  return useQuery({
    enabled,
    queryFn: () => api.get<{ data: SkillSource[] }>(BASE).then((r) => r.data),
    queryKey: ['skill-sources'],
  });
}

/** Source rows and the skills list (it carries each skill's external badge) move together. */
function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['skill-sources'] });
    qc.invalidateQueries({ queryKey: ['skills'] });
  };
}

export function usePreviewSource() {
  return useMutation({
    mutationFn: (body: SourceLocationInput) =>
      api.post<{ data: SourcePreview }>(`${BASE}/preview`, body).then((r) => r.data),
  });
}

export function useCreateSource() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: SourceLocationInput & { sha: string; skills: string[] }) =>
      api
        .post<{ data: { skills: Array<{ id: string; name: string }> } }>(BASE, body)
        .then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useCheckSource() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      api
        .post<{
          data: {
            check: { status: string; error: string | null };
            recorded: boolean;
            source: SkillSource;
          };
        }>(`${BASE}/${id}/check`, {})
        .then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function usePatchSource() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      scriptMode?: ScriptMode;
      status?: 'DISABLED' | 'OK';
    }) => api.patch<{ data: SkillSource }>(`${BASE}/${id}`, body).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useDeleteSource() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/${id}`),
    onSuccess: invalidate,
  });
}

/**
 * The per-skill diff against the source's latest commit, or against `sha`. Reads the
 * host; writes nothing.
 *
 * A review is a point-in-time read: everything the admin ticks (confirmations, picks,
 * the full text read) is about exactly this data, so it is frozen. It is read fresh when
 * the review opens and never again on its own: no refetch on focus, reconnect or after a
 * mutation (the key has its own root, outside the `skill-sources` invalidations). Only an
 * explicit `refetch()` re-reads it, and the caller then discards everything chosen.
 */
export function useSourceDiff(id: string | null, sha?: string) {
  return useQuery({
    enabled: id !== null,
    gcTime: 0,
    queryFn: () =>
      api
        .get<{ data: SourceDiff }>(
          `${BASE}/${id}/diff${sha ? `?${new URLSearchParams({ sha })}` : ''}`
        )
        .then((r) => r.data),
    queryKey: ['skill-source-diff', id, sha ?? 'latest'],
    refetchOnMount: 'always',
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** One skill's complete incoming text, for a diff that was cut or too large to show. */
export function useReadIncomingSkill() {
  return useMutation({
    mutationFn: ({ id, name, sha }: { id: string; name: string; sha: string }) =>
      api
        .get<{ data: IncomingSkill }>(
          `${BASE}/${id}/diff?${new URLSearchParams({ full: 'true', sha, skill: name })}`
        )
        .then((r) => r.data),
  });
}

/** One skill's complete text from a preview (the source does not exist yet), at the commit the ref resolves to. */
export function useReadPreviewSkill() {
  return useMutation({
    mutationFn: ({ skill, ...body }: SourceLocationInput & { skill: string }) =>
      api.post<{ data: IncomingSkill }>(`${BASE}/preview`, { ...body, skill }).then((r) => r.data),
  });
}

export function useAcceptUpdate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      sha: string;
      skills: Array<{ name: string; revision: number }>;
    }) => api.post<{ data: AcceptResult }>(`${BASE}/${id}/accept`, body).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useInstallIntoSource() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; sha: string; skills: string[] }) =>
      api
        .post<{ data: { skills: Array<{ id: string; name: string }> } }>(
          `${BASE}/${id}/install`,
          body
        )
        .then((r) => r.data),
    onSuccess: invalidate,
  });
}
