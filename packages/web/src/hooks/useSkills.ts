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
  usedByCount: number;
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
    }) =>
      api
        .put<{ data: Skill; scanWarnings?: string[] }>(`/api/v1/platform/skills/${id}`, body)
        .then(toSaveResult),
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
