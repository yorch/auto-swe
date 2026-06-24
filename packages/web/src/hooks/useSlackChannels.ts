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
  monthlyBudgetUsdCents?: number | null;
}

export interface UpdateSlackChannelBody {
  name?: string | null;
  agentKey?: string;
  ambientEnabled?: boolean;
  ambientCron?: string | null;
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
