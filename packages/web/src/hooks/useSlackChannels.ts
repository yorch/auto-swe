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
  monthlyBudgetUsdCents: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  workspace: SlackChannelWorkspace;
  currentMonthUsage: SlackChannelUsage | null;
}

export interface ChannelBudget {
  channelId: string;
  channelName: string | null;
  monthlyBudgetUsdCents: number | null;
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
  monthlyBudgetUsdCents?: number | null;
}

export interface UpdateSlackChannelBody {
  name?: string | null;
  agentKey?: string;
  ambientEnabled?: boolean;
  ambientCron?: string | null;
  reactiveEnabled?: boolean;
  reactiveCron?: string | null;
  monthlyBudgetUsdCents?: number | null;
  isActive?: boolean;
  teamId?: string;
}

const BASE = '/api/v1/admin/slack-channels';
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

export function useChannelBudget(id: string) {
  return useQuery({
    enabled: !!id,
    queryFn: () => api.get<ChannelBudget>(`${BASE}/${id}/budget`),
    queryKey: ['admin-slack-channel-budget', id],
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
