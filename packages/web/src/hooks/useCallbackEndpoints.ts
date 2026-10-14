'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** The events an endpoint may subscribe to, as the gateway accepts them. */
export const CALLBACK_EVENTS = ['run.completed', 'run.waiting_for_human'] as const;
export type CallbackEvent = (typeof CALLBACK_EVENTS)[number];

/** A team's run-callback receiver. The signing secret itself is never returned after creation. */
export interface CallbackEndpointRow {
  id: string;
  teamId: string;
  name: string;
  origin: string;
  pathPrefix: string;
  events: CallbackEvent[];
  allowPrivateNetwork: boolean;
  /** Whether a public template webhook call may name this endpoint. */
  acceptTemplateWebhookLaunches: boolean;
  disabled: boolean;
  disabledAt: string | null;
  secretLastFour: string;
  /** When the secret a rotation replaced stops signing deliveries; null when none is live. */
  previousSecretExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One delivery's outcome: never its payload, a response body or error text. A run viewer
 * outside the endpoint's team gets only `id`, `event`, `status`, the times and `target`.
 */
export interface CallbackDeliveryRow {
  id: string;
  event: CallbackEvent;
  status: 'PENDING' | 'DELIVERED' | 'DEAD';
  attempts?: number;
  nextAttemptAt?: string | null;
  lastAttemptAt?: string | null;
  lastStatusCode?: number | null;
  lastError?: string | null;
  deadReason?: string | null;
  deliveredAt: string | null;
  deadAt?: string | null;
  createdAt: string;
  workflowRunId?: string;
  /** Origin and path the delivery posts to; never the query. */
  target: string | null;
  endpoint?: { id: string; name: string; teamId: string } | null;
  canRedeliver?: boolean;
}

export interface CallbackEndpointInput {
  name: string;
  origin: string;
  pathPrefix?: string;
  events: CallbackEvent[];
  allowPrivateNetwork: boolean;
  acceptTemplateWebhookLaunches: boolean;
}

const base = (teamId: string) => `/api/v1/teams/${teamId}/callback-endpoints`;
const listKey = (teamId: string) => ['callback-endpoints', teamId];
const deliveriesKey = (teamId: string, endpointId: string) => [
  'callback-endpoint-deliveries',
  teamId,
  endpointId,
];

export function useCallbackEndpoints(teamId: string, enabled = true) {
  return useQuery({
    enabled: enabled && !!teamId,
    queryFn: () => api.get<{ data: CallbackEndpointRow[] }>(base(teamId)).then((r) => r.data),
    queryKey: listKey(teamId),
  });
}

export function useCreateCallbackEndpoint(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CallbackEndpointInput) =>
      api.post<{ data: CallbackEndpointRow; secret: string }>(base(teamId), body),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(teamId) }),
  });
}

export function useUpdateCallbackEndpoint(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: Partial<CallbackEndpointInput> & { id: string; disabled?: boolean }) =>
      api.patch<{ data: CallbackEndpointRow }>(`${base(teamId)}/${id}`, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(teamId) }),
  });
}

export function useRotateCallbackSecret(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: CallbackEndpointRow; secret: string; previousSecretExpiresAt: string }>(
        `${base(teamId)}/${id}/rotate-secret`,
        {}
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(teamId) }),
  });
}

export function useDeleteCallbackEndpoint(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${base(teamId)}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(teamId) }),
  });
}

export function useCallbackEndpointDeliveries(teamId: string, endpointId: string | null) {
  return useQuery({
    enabled: !!teamId && !!endpointId,
    queryFn: () =>
      api
        .get<{ data: CallbackDeliveryRow[]; total: number }>(
          `${base(teamId)}/${endpointId}/deliveries?limit=50`
        )
        .then((r) => r),
    queryKey: deliveriesKey(teamId, endpointId ?? ''),
  });
}

export function useRunCallbackDeliveries(runId: string) {
  return useQuery({
    enabled: !!runId,
    queryFn: () =>
      api
        .get<{ data: { target: string | null; deliveries: CallbackDeliveryRow[] } }>(
          `/api/v1/workflow-runs/${runId}/callback-deliveries`
        )
        .then((r) => r.data),
    queryKey: ['run-callback-deliveries', runId],
  });
}

export function useRedeliverCallback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: { teamId: string; endpointId: string; deliveryId: string }) =>
      api.post<{ data: CallbackDeliveryRow }>(
        `${base(d.teamId)}/${d.endpointId}/deliveries/${d.deliveryId}/redeliver`,
        {}
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['callback-endpoint-deliveries'] });
      void qc.invalidateQueries({ queryKey: ['run-callback-deliveries'] });
    },
  });
}
