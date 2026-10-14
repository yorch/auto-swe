'use client';

import type { EventEndpointConfig } from '@auto-swe/shared/automation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** A team's event endpoint (docs/inbound-events.md), as the API returns it: never its secret. */
export interface EventEndpoint extends EventEndpointConfig {
  id: string;
  teamId: string;
  name: string;
  enabled: boolean;
  /** The receiver's path, relative to the gateway: give the sender the full URL. */
  path: string;
  secretLastFour: string;
  /** While the secret a rotation replaced is still accepted. */
  previousSecretExpiresAt: string | null;
  previousSecretLastFour: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What creating an endpoint sends. */
export type EventEndpointInput = Partial<EventEndpointConfig> &
  Pick<EventEndpointConfig, 'scheme' | 'format'> & {
    name: string;
    enabled?: boolean;
    /** A secret the sender chose; omit to have one generated and shown once. */
    secret?: string;
  };

const key = (teamId: string) => ['teams', teamId, 'event-endpoints'];
const base = (teamId: string) => `/api/v1/teams/${encodeURIComponent(teamId)}/event-endpoints`;

export function useEventEndpoints(teamId: string, enabled = true) {
  return useQuery({
    enabled: enabled && !!teamId,
    queryFn: () =>
      api
        .get<{ data: { canManage: boolean; endpoints: EventEndpoint[] } }>(base(teamId))
        .then((r) => r.data),
    queryKey: key(teamId),
  });
}

/** Returns the endpoint and, when the platform generated it, its secret — once. */
export function useCreateEventEndpoint(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EventEndpointInput) =>
      api
        .post<{ data: EventEndpoint & { secret?: string } }>(base(teamId), body)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(teamId) }),
  });
}

export function useUpdateEventEndpoint(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<EventEndpointInput> & { id: string }) =>
      api.patch(`${base(teamId)}/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(teamId) }),
  });
}

/** A new secret; the old one is accepted for 24 hours. Returns the new one when generated. */
export function useRotateEventEndpointSecret(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api
        .post<{ data: EventEndpoint & { secret?: string } }>(
          `${base(teamId)}/${id}/secret/rotate`,
          {}
        )
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(teamId) }),
  });
}

export function useDeleteEventEndpoint(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${base(teamId)}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(teamId) }),
  });
}
