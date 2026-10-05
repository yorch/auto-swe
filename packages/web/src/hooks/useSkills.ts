'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** A skill row as `/api/v1/platform/skills` returns it. */
export interface Skill {
  id: string;
  name: string;
  description: string | null;
  promptText: string;
  origin: string | null;
  isBuiltIn: boolean;
  isVerified: boolean;
  isActive: boolean;
  /** The revision this row's text is; send it back as `expectedRevision` on edit. */
  currentRevision: number;
  usedByCount: number;
  /** Keys of the active agents that reference this skill. */
  usedBy: string[];
  /** Advisory scanner findings recorded on the current revision. */
  scanWarnings: string[];
  /** Set for a skill imported from an external repository; `sha` is the commit its current text came from. */
  externalSource: { host: string; owner: string; repo: string; sha: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

/** The subset the agent editors need to render a skill picker. `Skill`
 *  satisfies it, so either can be handed to `SkillRefEditor`. */
export interface SkillOption {
  id: string;
  name: string;
  description: string | null;
  isBuiltIn: boolean;
}

export interface SkillEffectiveness {
  windowDays: number;
  totalRuns: number;
  baselineSuccessRate: number | null;
  caveat: string;
  perSkill: Array<{
    name: string;
    runs: number;
    successRate: number | null;
    avgCostUsd: number | null;
  }>;
}

/**
 * One `['skills', …]` key space for the whole package. The admin page used to
 * declare its own copy of this query under a different key, so a skill created
 * there never invalidated the list the agent editors read.
 */
export function useSkills() {
  return useQuery({
    queryFn: () => api.get<{ data: Skill[] }>('/api/v1/platform/skills').then((r) => r.data),
    queryKey: ['skills', 'all'],
  });
}

/**
 * The skills a team's members may pick for TEAM-scope agents:
 * `GET /teams/:teamId/skills` (GLOBAL rows plus this team's and org's own).
 * The team agent library uses this rather than the ADMIN-only platform list,
 * which a team ADMIN who is not a platform ADMIN cannot read.
 */
export function useTeamSkills(teamId: string) {
  return useQuery({
    queryFn: () =>
      api.get<{ data: SkillOption[] }>(`/api/v1/teams/${teamId}/skills`).then((r) => r.data),
    queryKey: ['skills', 'team', teamId],
  });
}

export function useSkillEffectiveness() {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: SkillEffectiveness }>('/api/v1/platform/skills/effectiveness')
        .then((r) => r.data),
    queryKey: ['skills', 'effectiveness'],
  });
}

/**
 * A saved skill plus the advisory findings of the content scanner. The gateway
 * saves the skill regardless and returns `scanWarnings` only when there are
 * some; they are surfaced to the author rather than dropped.
 */
export interface SkillSaveResult {
  skill: Skill;
  scanWarnings: string[];
}

function toSaveResult(r: { data: Skill; scanWarnings?: string[] }): SkillSaveResult {
  return { scanWarnings: r.scanWarnings ?? [], skill: r.data };
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string; promptText: string }) =>
      api
        .post<{ data: Skill; scanWarnings?: string[] }>('/api/v1/platform/skills', body)
        .then(toSaveResult),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      description?: string;
      promptText?: string;
      isActive?: boolean;
      /** The revision the editor read; a skill that moved on answers 409. */
      expectedRevision?: number;
    }) =>
      api
        .put<{ data: Skill; scanWarnings?: string[] }>(`/api/v1/platform/skills/${id}`, body)
        .then(toSaveResult),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

/**
 * An admin attests to the text of the revision they read; a skill that moved on
 * since answers 409 `SKILL_CHANGED`. The only way a skill becomes verified.
 */
export function useVerifySkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, revision }: { id: string; revision: number }) =>
      api.post<{ data: Skill }>(`/api/v1/platform/skills/${id}/verify`, { revision }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/platform/skills/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      // Agents reference skills by key; the library view shows those refs.
      qc.invalidateQueries({ queryKey: ['admin-agent-library'] });
    },
  });
}

// ── Revision history ──────────────────────────────────────────────────────────

export interface SkillRevisionRow {
  id: string;
  revision: number;
  promptText: string;
  description: string | null;
  createdAt: string;
  createdByEmail: string | null;
  isCurrent: boolean;
}

/** Every saved revision of a skill, newest first. */
export function useSkillRevisions(id: string | null) {
  return useQuery({
    enabled: id !== null,
    queryFn: () =>
      api
        .get<{ data: SkillRevisionRow[] }>(`/api/v1/platform/skills/${id}/revisions`)
        .then((r) => r.data),
    queryKey: ['skills', 'revisions', id],
  });
}

/** Save an older revision's text as a new revision. */
export function useRestoreSkillRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, revision }: { id: string; revision: number }) =>
      api
        .post<{
          data: Skill;
          scanWarnings?: string[];
        }>(`/api/v1/platform/skills/${id}/revisions/${revision}/restore`, {})
        .then(toSaveResult),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      // A restored skill changes what agents bound to it inject, and the library lists those.
      qc.invalidateQueries({ queryKey: ['admin-agent-library'] });
    },
  });
}
