'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

const BASE = '/api/v1/platform/skill-sources';
const KEY = ['skill-sources'];

export type SkillSourceStatus = 'OK' | 'UPDATE_AVAILABLE' | 'ERROR' | 'DISABLED';
export type SkillScriptMode = 'TEXT_ONLY' | 'REJECT';

/** Where a source is read from. `path` is the folder inside the repository ('' = the root). */
export interface SkillSourceLocation {
  host: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
  scriptMode: SkillScriptMode;
}

export interface SkillSourceRow {
  id: string;
  host: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
  pinnedSha: string;
  latestSha: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  status: SkillSourceStatus;
  scriptMode: SkillScriptMode;
  scope: string;
  skillCount: number;
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
  skippedFiles: SkippedFile[];
  scanWarnings: string[];
  conflicts: Array<{ id: string; name: string; scope: string }>;
  errors: string[];
  blockedByScan: boolean;
  installable: boolean;
}

export interface SkillSourcePreview {
  sha: string;
  skills: PreviewSkill[];
}

export interface DiffChangedSkill {
  name: string;
  skillId: string;
  installedRevision: number;
  handEdited: boolean;
  blockedByScan: boolean;
  diffIncomplete: boolean;
  description: { changed: boolean; old: string | null; new: string | null };
  textDiff: string;
  textDiffTruncated: boolean;
  scanWarnings: string[];
  renamedTo: string | null;
  referenceFiles: { added: string[]; changed: string[]; removed: string[] };
}

export interface SkillSourceDiff {
  sha: string;
  changed: DiffChangedSkill[];
  added: Array<{ folder: string; name: string | null }>;
  removed: Array<{ name: string; folder: string }>;
  errors: Array<{ name: string; folder: string; errors: string[] }>;
  unchanged: Array<{ name: string }>;
}

export interface AcceptSummary {
  accepted: Array<{ name: string; revision: number }>;
  conflicts: string[];
  notSelected: string[];
  pinAdvanced: boolean;
}

export function useSkillSources() {
  return useQuery({
    queryFn: () => api.get<{ data: SkillSourceRow[] }>(BASE).then((r) => r.data),
    queryKey: KEY,
  });
}

export function usePreviewSkillSource() {
  return useMutation({
    mutationFn: (body: SkillSourceLocation) =>
      api.post<{ data: SkillSourcePreview }>(`${BASE}/preview`, body).then((r) => r.data),
  });
}

export function useImportSkillSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SkillSourceLocation & { sha: string; skills: string[] }) =>
      api.post<{ data: { skills: unknown[] } }>(BASE, body).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

export function useCheckSkillSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{
        data: { check: { status: string; error: string | null }; source: SkillSourceRow };
      }>(`${BASE}/${id}/check`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSkillSourceDiff(id: string | null) {
  return useQuery({
    enabled: id !== null,
    queryFn: () => api.get<{ data: SkillSourceDiff }>(`${BASE}/${id}/diff`).then((r) => r.data),
    queryKey: [...KEY, id, 'diff'],
    // A diff is a read of an external host; reading it again on focus would spend its request budget.
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
}

export function useAcceptSkillUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      sha: string;
      skills: Array<{ name: string; revision: number }>;
    }) => api.post<{ data: AcceptSummary }>(`${BASE}/${id}/accept`, body).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

export function useDeleteSkillSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}
