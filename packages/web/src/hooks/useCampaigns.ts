'use client';

import type {
  CampaignActionResponse,
  CampaignCountsDto,
  CampaignCreateBody,
  CampaignDetailDto,
  CampaignEditTargetBody,
  CampaignEditTargetResponse,
  CampaignLaunchResponse,
  CampaignRemoveDependencyResponse,
  CampaignSummaryDto,
  CampaignTargetActionResponse,
  CampaignTargetDto,
} from '@auto-swe/shared/lib/campaignApi';
import {
  CAMPAIGN_STATE_VALUES,
  CAMPAIGN_TARGET_STATE_VALUES,
  type CampaignPlanValue,
  type CampaignStateValue,
  isCampaignFinal,
  type TargetState,
} from '@auto-swe/shared/lib/campaignState';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { ApiError, api } from '@/lib/api';
import { randomId } from '@/lib/randomId';

/** Every value the gateway may send, including the ones only legacy campaigns carry. */
export const CAMPAIGN_STATES = CAMPAIGN_STATE_VALUES;
export type CampaignState = CampaignStateValue;

export const CAMPAIGN_TARGET_STATES = CAMPAIGN_TARGET_STATE_VALUES;
export type CampaignTargetState = TargetState;

export type CampaignPlan = CampaignPlanValue;

/** A campaign in one of these states never moves again (the shared definition). */
export function isCampaignTerminal(state: string): boolean {
  return isCampaignFinal(state as CampaignStateValue);
}

/** The number of targets per bucket, over every target (including ones the viewer cannot see). */
export type CampaignCounts = CampaignCountsDto;

interface PersonRef {
  id: string;
  name: string | null;
}

/**
 * Fields the gateway still sends beside the shared wire shape. They are optional here because the
 * shared schema does not promise them: the page shows what is present and never needs one.
 */
interface CampaignDisplayExtras {
  createdBy?: PersonRef | null;
  ownerTeam?: { id: string; name: string };
  recipeParams?: { packageName: string; targetVersion: string } | null;
  completedAt?: string | null;
  /** Every child run of a legacy campaign shares this work request; used to find its run page. */
  workRequestId?: string;
}

/** A row of GET /api/v1/campaigns. */
export type CampaignSummary = CampaignSummaryDto & CampaignDisplayExtras;

export type CampaignTarget = CampaignTargetDto;

/** GET /api/v1/campaigns/:id. */
export type CampaignDetail = CampaignDetailDto & CampaignDisplayExtras;

/** The body of POST /api/v1/campaigns. */
export type CreateCampaignBody = CampaignCreateBody;

export type CreateCampaignResponse = Partial<CampaignLaunchResponse> & {
  campaignId: string;
  targetCount: number;
  detailPath?: string;
  /** Present and true when the Idempotency-Key had already launched this exact request. */
  deduplicated?: boolean;
};

/** Whether a failure is the gateway saying the campaign does not exist (or is not visible). */
export function isCampaignNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

const POLL_MS = 10_000;

export function useCampaigns(
  filters: { limit?: number; offset?: number; plan?: CampaignPlan; state?: CampaignState } = {},
  options: { enabled?: boolean; teamId?: string } = {}
) {
  const teamId = options.teamId ?? null;
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit ?? 50));
  params.set('offset', String(filters.offset ?? 0));
  if (filters.state) {
    params.set('state', filters.state);
  }
  if (filters.plan) {
    params.set('plan', filters.plan);
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
    // Refresh every ten seconds while any campaign on the page can still change; a page of final
    // campaigns is left alone. Without an answer yet (loading or failed) keep trying.
    refetchInterval: (query) => {
      const rows = query.state.data?.data;
      return !rows || rows.some((c) => !isCampaignTerminal(c.state)) ? POLL_MS : false;
    },
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
      query.state.data && isCampaignTerminal(query.state.data.state) ? false : POLL_MS,
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

function useRefreshCampaign(id: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['campaign', id] });
    qc.invalidateQueries({ queryKey: ['campaigns'] });
  };
}

function campaignPath(id: string, tail = ''): string {
  return `/api/v1/campaigns/${encodeURIComponent(id)}${tail}`;
}

/** The answer to cancel. Older gateways name the id `campaignId`; nothing here reads it. */
type CancelResponse = Partial<CampaignActionResponse> & { campaignId?: string };

export function useCancelCampaign(id: string) {
  const refresh = useRefreshCampaign(id);
  return useMutation({
    mutationFn: () => api.post<{ data: CancelResponse }>(campaignPath(id, '/cancel'), {}),
    onSuccess: refresh,
  });
}

function useCampaignAction(id: string, action: 'confirm' | 'pause' | 'resume' | 'takeover') {
  const refresh = useRefreshCampaign(id);
  return useMutation({
    mutationFn: () =>
      api.post<{ data: CampaignActionResponse }>(campaignPath(id, `/${action}`), {}),
    onSuccess: refresh,
  });
}

/** PLANNING to ACTIVE: the launcher accepts the planner's briefs and edges. */
export const useConfirmCampaign = (id: string) => useCampaignAction(id, 'confirm');
export const usePauseCampaign = (id: string) => useCampaignAction(id, 'pause');
export const useResumeCampaign = (id: string) => useCampaignAction(id, 'resume');
/** Re-runs the launch decision for every unfinished target as the caller. */
export const useTakeOverCampaign = (id: string) => useCampaignAction(id, 'takeover');

/** A new attempt for a target that needs a person. */
export function useRetryCampaignTarget(id: string) {
  const refresh = useRefreshCampaign(id);
  return useMutation({
    mutationFn: (targetId: string) =>
      api.post<{ data: CampaignTargetActionResponse }>(
        campaignPath(id, `/targets/${encodeURIComponent(targetId)}/retry`),
        {}
      ),
    onSuccess: refresh,
  });
}

/** Skips a target; nothing on the host is touched. */
export function useRemoveCampaignTarget(id: string) {
  const refresh = useRefreshCampaign(id);
  return useMutation({
    mutationFn: (targetId: string) =>
      api.delete<{ data: CampaignTargetActionResponse }>(
        campaignPath(id, `/targets/${encodeURIComponent(targetId)}`)
      ),
    onSuccess: refresh,
  });
}

/** The launcher's edit of one planned target; the gateway answers with what it stored. */
export type EditCampaignTargetBody = CampaignEditTargetBody;

/**
 * Rewrites a planned target's brief and/or the targets it starts after, while the campaign is
 * still being planned. The stored values replace the target in the cached detail at once, so the
 * plan view shows what the gateway kept; the refetch then confirms it.
 */
export function useEditCampaignTarget(id: string) {
  const qc = useQueryClient();
  const refresh = useRefreshCampaign(id);
  return useMutation({
    mutationFn: ({ body, targetId }: { body: EditCampaignTargetBody; targetId: string }) =>
      api
        .patch<CampaignEditTargetResponse>(
          campaignPath(id, `/targets/${encodeURIComponent(targetId)}`),
          body
        )
        .then((r) => r.data),
    onSuccess: (stored) => {
      qc.setQueryData<CampaignDetail>(['campaign', id], (old) =>
        old
          ? {
              ...old,
              targets: old.targets.map((t) =>
                t.id === stored.id ? { ...t, brief: stored.brief, dependsOn: stored.dependsOn } : t
              ),
            }
          : old
      );
      refresh();
    },
  });
}

/** Drops one wait edge of a running campaign: the target no longer waits for that upstream. */
export function useRemoveCampaignDependency(id: string) {
  const refresh = useRefreshCampaign(id);
  return useMutation({
    mutationFn: ({ targetId, upstreamId }: { targetId: string; upstreamId: string }) =>
      api.delete<CampaignRemoveDependencyResponse>(
        campaignPath(
          id,
          `/targets/${encodeURIComponent(targetId)}/dependencies/${encodeURIComponent(upstreamId)}`
        )
      ),
    onSuccess: refresh,
  });
}
