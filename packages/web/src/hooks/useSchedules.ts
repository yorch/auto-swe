'use client';

import type { ScheduledWorkRequestSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface CreateScheduleBody {
  name: string;
  cronExpression: string;
  repoId: string;
  description: string;
  externalTicketPrefix: string;
  budgetTier?: 'STANDARD' | 'LARGE' | 'EPIC';
  isActive?: boolean;
  templateId?: string;
  templateVersion?: number;
}

export interface UpdateScheduleBody {
  name?: string;
  cronExpression?: string;
  description?: string;
  budgetTier?: 'STANDARD' | 'LARGE' | 'EPIC';
  isActive?: boolean;
  templateId?: string | null;
  templateVersion?: number | null;
}

const BASE = '/api/v1/scheduled-work-requests';

export function useSchedules() {
  return useQuery({
    queryFn: () => api.get<{ data: ScheduledWorkRequestSummary[] }>(BASE).then((r) => r.data),
    queryKey: ['scheduled-work-requests'],
  });
}

export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateScheduleBody) =>
      api.post<{ data: ScheduledWorkRequestSummary }>(BASE, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduled-work-requests'] }),
  });
}

export function useUpdateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateScheduleBody & { id: string }) =>
      api.patch<{ data: ScheduledWorkRequestSummary }>(`${BASE}/${id}`, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduled-work-requests'] }),
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ data: { deleted: boolean } }>(`${BASE}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduled-work-requests'] }),
  });
}

export function useFireSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { triggered: boolean } }>(`${BASE}/${id}/fire`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduled-work-requests'] }),
  });
}
