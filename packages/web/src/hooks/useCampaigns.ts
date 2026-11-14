'use client';

import type { BudgetTier } from '@auto-swe/shared/types/workflow';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { ApiError, api } from '@/lib/api';
import { randomId } from '@/lib/randomId';

export const CAMPAIGN_STATES = [
  'STARTING',
  'RUNNING',
  'CANCELLING',
  'COMPLETED',
  'COMPLETED_WITH_FAILURES',
  'CANCELLED',
  'FAILED_TO_START',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export const CAMPAIGN_TARGET_STATES = [
  'PENDING',
  'RUNNING',
  'PR_OPENED',
  'NOT_AFFECTED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const;
export type CampaignTargetState = (typeof CAMPAIGN_TARGET_STATES)[number];

/** States a campaign never leaves; mirrors `CAMPAIGN_TERMINAL_STATES` in the gateway. */
const TERMINAL_STATES: readonly string[] = [
  'COMPLETED',
  'COMPLETED_WITH_FAILURES',
  'CANCELLED',
  'FAILED_TO_START',
];

export function isCampaignTerminal(state: string): boolean {
  return TERMINAL_STATES.includes(state);
}

/** The number of targets in each state, over every target (including ones the viewer cannot see). */
export type CampaignCounts = Record<CampaignTargetState, number>;

interface PersonRef {
  id: string;
  name: string | null;
}

interface CampaignRecipeFields {
  recipeRef: string | null;
  recipeParams: { packageName: string; targetVersion: string } | null;
}

/** A row of GET /api/v1/campaigns. */
export interface CampaignSummary extends CampaignRecipeFields {
  id: string;
  name: string;
  state: CampaignState;
  createdAt: string;
  completedAt: string | null;
  createdBy: PersonRef | null;
  ownerTeam: { id: string; name: string };
  counts: CampaignCounts;
}

export interface CampaignTarget {
  childWorkflowId: string | null;
  connectionId: string | null;
  failureReason: string | null;
  finishedAt: string | null;
  path: 'RECIPE' | 'AGENT' | 'RECIPE_THEN_AGENT' | 'NONE' | null;
  position: number;
  prNumber: number | null;
  prUrl: string | null;
  repoLabel: string;
  startedAt: string | null;
  state: CampaignTargetState;
  verification: 'PASSED' | 'FAILED' | 'NOT_RUN' | null;
  /** The child's live phase while it runs. */
  liveStatus: string | null;
}

/** GET /api/v1/campaigns/:id. */
export interface CampaignDetail extends CampaignRecipeFields {
  id: string;
  name: string;
  description: string;
  state: CampaignState;
  cancelledAt: string | null;
  cancelledById: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: PersonRef | null;
  ownerTeam: { id: string; name: string };
  maxParallel: number;
  orgId: string;
  templateId: string;
  templateVersion: number;
  temporalWorkflowId: string;
  workRequestId: string;
  counts: CampaignCounts;
  /** Targets the viewer cannot reach: counted, never named. */
  hiddenTargetCount: number;
  targets: CampaignTarget[];
}

/** The body of POST /api/v1/campaigns. */
export interface CreateCampaignBody {
  name: string;
  description: string;
  ownerTeamId: string;
  repoIds: string[];
  recipe?: { ref: string; params: { packageName: string; targetVersion: string } };
  maxParallel?: number;
  budget?: BudgetTier;
}

export interface CreateCampaignResponse {
  campaignId: string;
  temporalWorkflowId: string;
  workRequestId: string;
  targetCount: number;
  detailPath: string;
  /** Present and true when the Idempotency-Key had already launched this exact request. */
  deduplicated?: boolean;
}

/** Whether a failure is the gateway saying the campaign does not exist (or is not visible). */
export function isCampaignNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function useCampaigns(
  filters: { limit?: number; offset?: number; state?: CampaignState } = {},
  options: { enabled?: boolean; teamId?: string } = {}
) {
  const teamId = options.teamId ?? null;
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit ?? 50));
  params.set('offset', String(filters.offset ?? 0));
  if (filters.state) {
    params.set('state', filters.state);
  }
  if (teamId) {
    params.set('ownerTeamId', teamId);
  }
  return useQuery({
    enabled: options.enabled ?? true,
    queryFn: () =>
      api
        .get<{
          data: CampaignSummary[];
          meta: { limit: number; offset: number; total: number };
        }>(`/api/v1/campaigns?${params.toString()}`)
        .then((r) => ({ data: r.data, meta: r.meta })),
    queryKey: ['campaigns', filters, teamId],
    refetchInterval: 10_000,
  });
}

export function useCampaign(id: string) {
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api
        .get<{ data: CampaignDetail }>(`/api/v1/campaigns/${encodeURIComponent(id)}`)
        .then((r) => r.data),
    queryKey: ['campaign', id],
    // A final campaign no longer changes.
    refetchInterval: (query) =>
      query.state.data && isCampaignTerminal(query.state.data.state) ? false : 10_000,
    // A campaign the viewer cannot see does not exist as far as the gateway says; do not retry it.
    retry: (count, error) => !isCampaignNotFound(error) && count < 2,
  });
}

/**
 * Starts a campaign. One Idempotency-Key is kept for as long as the request is the same, so a
 * retry after a lost response answers with the campaign the first call launched instead of
 * starting a second; a changed request gets a new key.
 */
export function useCreateCampaign() {
  const qc = useQueryClient();
  const submission = useRef<{ body: string; key: string } | null>(null);
  return useMutation({
    mutationFn: (body: CreateCampaignBody) => {
      const serialised = JSON.stringify(body);
      if (submission.current?.body !== serialised) {
        submission.current = { body: serialised, key: randomId() };
      }
      return api
        .fetch<{ data: CreateCampaignResponse }>('/api/v1/campaigns', {
          body: serialised,
          headers: { 'Idempotency-Key': submission.current.key },
          method: 'POST',
        })
        .then((r) => r.data);
    },
    onSuccess: () => {
      submission.current = null;
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}

export function useCancelCampaign(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ data: { campaignId: string; state: CampaignState } }>(
        `/api/v1/campaigns/${encodeURIComponent(id)}/cancel`,
        {}
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaign', id] });
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}
