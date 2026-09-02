'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface SlackChannelWorkspace {
  id: string;
  name: string | null;
  orgId: string | null;
  slackTeamId: string;
}

export interface SlackChannelUsage {
  costUsdAccrued: number;
  runsCompleted: number;
  yearMonth: string;
}

export interface SlackChannel {
  id: string;
  slackChannelId: string;
  workspaceId: string;
  name: string | null;
  teamId: string;
  orgId: string | null;
  agentKey: string;
  ambientEnabled: boolean;
  ambientCron: string | null;
  reactiveEnabled: boolean;
  reactiveCron: string | null;
  passiveIngestEnabled: boolean;
  isPrivate: boolean;
  orgFlaggingEnabled: boolean;
  followupSessionEnabled: boolean;
  consolidationEnabled: boolean;
  consolidationMinClusterSize: number | null;
  consolidationSimilarityThreshold: number | null;
  monthlyBudgetUsdCents: number | null;
  personaPrompt: string | null;
  reactiveCooldownMinutes: number | null;
  reactiveLookbackMinutes: number | null;
  orgFlagCooldownHours: number | null;
  openItemNudgeAfterHours: number | null;
  openItemNudgeCooldownHours: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  workspace: SlackChannelWorkspace;
  currentMonthUsage: SlackChannelUsage | null;
}

export interface CreateSlackChannelBody {
  slackChannelId: string;
  slackTeamId: string;
  teamId: string;
  name?: string | null;
  agentKey?: string;
  ambientEnabled?: boolean;
  ambientCron?: string | null;
  reactiveEnabled?: boolean;
  reactiveCron?: string | null;
  passiveIngestEnabled?: boolean;
  isPrivate?: boolean;
  orgFlaggingEnabled?: boolean;
  followupSessionEnabled?: boolean;
  consolidationEnabled?: boolean;
  consolidationMinClusterSize?: number | null;
  consolidationSimilarityThreshold?: number | null;
  monthlyBudgetUsdCents?: number | null;
  personaPrompt?: string | null;
}

export interface UpdateSlackChannelBody {
  name?: string | null;
  agentKey?: string;
  ambientEnabled?: boolean;
  ambientCron?: string | null;
  reactiveEnabled?: boolean;
  reactiveCron?: string | null;
  passiveIngestEnabled?: boolean;
  isPrivate?: boolean;
  orgFlaggingEnabled?: boolean;
  followupSessionEnabled?: boolean;
  consolidationEnabled?: boolean;
  consolidationMinClusterSize?: number | null;
  consolidationSimilarityThreshold?: number | null;
  monthlyBudgetUsdCents?: number | null;
  personaPrompt?: string | null;
  reactiveCooldownMinutes?: number | null;
  reactiveLookbackMinutes?: number | null;
  orgFlagCooldownHours?: number | null;
  openItemNudgeAfterHours?: number | null;
  openItemNudgeCooldownHours?: number | null;
  isActive?: boolean;
  teamId?: string;
}

const BASE = '/api/v1/platform/slack-channels';
const KEY = ['admin-slack-channels'];

export function useSlackChannels() {
  return useQuery({
    queryFn: () => api.get<{ data: SlackChannel[] }>(BASE).then((r) => r.data),
    queryKey: KEY,
  });
}

export function useCreateSlackChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSlackChannelBody) =>
      api.post<{ data: SlackChannel }>(BASE, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateSlackChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & UpdateSlackChannelBody) =>
      api.patch<{ data: SlackChannel }>(`${BASE}/${id}`, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteSlackChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ data: { deleted: true } }>(`${BASE}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

// ── Multi-workspace install (Full multi-workspace) ─────────────────────────────

export interface SlackWorkspaceRow {
  workspaceId: string;
  slackTeamId: string;
  name: string | null;
  orgId: string;
  /** True once the workspace completed the bot-install flow (has its own token). */
  installed: boolean;
  installedAt: string | null;
  /** Masked last-four of the per-workspace bot token (null until installed). */
  tokenLastFour: string | null;
  isActive: boolean;
  channelCount: number;
  createdAt: string;
}

export function useSlackWorkspaces() {
  return useQuery({
    queryFn: () => api.get<{ data: SlackWorkspaceRow[] }>(`${BASE}/workspaces`).then((r) => r.data),
    queryKey: ['admin-slack-workspaces'],
  });
}

export interface MemoryItemDto {
  id: string;
  lessonSummary: string;
  rationale: string;
  agentKey: string | null;
  metadata: unknown;
  createdAt: string;
  /** Gap F: non-null when this item was merged into a consolidated successor. */
  consolidatedAt: string | null;
}

export function useChannelMemory(channelId: string | null, includeConsolidated = false) {
  return useQuery({
    enabled: !!channelId,
    queryFn: () => {
      const qs = includeConsolidated ? '?includeConsolidated=true' : '';
      return api
        .get<{ data: MemoryItemDto[] }>(`${BASE}/${channelId}/memory${qs}`)
        .then((r) => r.data);
    },
    queryKey: ['admin-slack-channel-memory', channelId, includeConsolidated],
  });
}

export function useDeleteChannelMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, memoryId }: { channelId: string; memoryId: string }) =>
      api.delete<{ data: { deleted: true } }>(`${BASE}/${channelId}/memory/${memoryId}`),
    onSuccess: (_data, { channelId }) => {
      qc.invalidateQueries({ queryKey: ['admin-slack-channel-memory', channelId] });
    },
  });
}

export interface UpdateChannelMemoryBody {
  lessonSummary?: string;
  rationale?: string;
}

export function useUpdateChannelMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      channelId,
      memoryId,
      ...body
    }: { channelId: string; memoryId: string } & UpdateChannelMemoryBody) =>
      api
        .patch<{ data: MemoryItemDto }>(`${BASE}/${channelId}/memory/${memoryId}`, body)
        .then((r) => r.data),
    onSuccess: (_data, { channelId }) => {
      qc.invalidateQueries({ queryKey: ['admin-slack-channel-memory', channelId] });
    },
  });
}

// ── Open items (Gap C) ───────────────────────────────────────────────────────

export type ChannelOpenItemStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

export interface ChannelOpenItemDto {
  id: string;
  channelId: string;
  description: string;
  ownerUserId: string | null;
  status: ChannelOpenItemStatus;
  sourceTs: string | null;
  lastNudgedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function useChannelOpenItems(
  channelId: string | null,
  status: ChannelOpenItemStatus | 'all' = 'OPEN'
) {
  return useQuery({
    enabled: !!channelId,
    queryFn: () => {
      const qs = status !== 'all' ? `?status=${status}` : '';
      return api
        .get<{ data: ChannelOpenItemDto[] }>(`${BASE}/${channelId}/open-items${qs}`)
        .then((r) => r.data);
    },
    queryKey: ['admin-slack-channel-open-items', channelId, status],
  });
}

export function useUpdateChannelOpenItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      channelId,
      itemId,
      status,
    }: {
      channelId: string;
      itemId: string;
      status: ChannelOpenItemStatus;
    }) =>
      api
        .patch<{ data: ChannelOpenItemDto }>(`${BASE}/${channelId}/open-items/${itemId}`, {
          status,
        })
        .then((r) => r.data),
    onSuccess: (_data, { channelId }) => {
      qc.invalidateQueries({ queryKey: ['admin-slack-channel-open-items', channelId] });
    },
  });
}

// ── Gap J: per-channel audit feed ──────────────────────────────────────────────

export type ChannelAuditKind = 'mention' | 'ambient' | 'reactive';

export interface ChannelAuditEntry {
  runId: string;
  kind: ChannelAuditKind;
  status: string;
  userSlackId: string | null;
  userText: string | null;
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  createdAt: string;
  endedAt: string | null;
}

export function useChannelAudit(channelId: string | null, kind: ChannelAuditKind | 'all' = 'all') {
  return useQuery({
    enabled: !!channelId,
    queryFn: () => {
      const qs = kind !== 'all' ? `?kind=${kind}` : '';
      return api
        .get<{ data: ChannelAuditEntry[] }>(`${BASE}/${channelId}/audit${qs}`)
        .then((r) => r.data);
    },
    queryKey: ['admin-slack-channel-audit', channelId, kind],
  });
}
