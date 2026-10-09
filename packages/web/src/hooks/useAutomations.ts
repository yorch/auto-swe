'use client';

import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** An event automation (docs/automations.md), as the API returns it. */
export interface EventAutomation {
  id: string;
  connectionId: string;
  name: string;
  enabled: boolean;
  /** An event source key, e.g. `github.workflow_run.failed`. */
  source: string;
  /** The source's filters. */
  filters: Record<string, unknown>;
  /** The template options this automation sets; anything absent takes the template default. */
  inputs: Record<string, unknown>;
  cooldownMinutes: number;
  maxRunsPerDay: number;
  templateId: string | null;
  template: { id: string; name: string } | null;
  createdAt: string;
}

/** One decision an automation made. */
export interface AutomationFire {
  id: string;
  outcome: string;
  reason: string | null;
  scopeKey: string;
  subjectKey: string;
  /** The occurrence as the source saw it. */
  facts: Record<string, unknown>;
  temporalWorkflowId: string | null;
  workRequestId: string | null;
  createdAt: string;
}

/** A template an automation of a source may start, with the options it lets one set. */
export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  /** The source's default, which an automation with no template starts. */
  builtIn: boolean;
  options: InputSchema;
}

export type EventAutomationInput = Pick<
  EventAutomation,
  'name' | 'enabled' | 'filters' | 'inputs' | 'cooldownMinutes' | 'maxRunsPerDay' | 'templateId'
>;

const BASE = '/api/v1/automations/events';
const key = (connectionId: string) => ['automations', 'events', connectionId];

export function useEventAutomations(connectionId: string) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: { canManage: boolean; automations: EventAutomation[] } }>(
          `${BASE}?connectionId=${encodeURIComponent(connectionId)}`
        )
        .then((r) => r.data),
    queryKey: key(connectionId),
  });
}

export function useAutomationTemplates(connectionId: string, source: string, enabled = true) {
  return useQuery({
    enabled,
    queryFn: () =>
      api
        .get<{ data: AutomationTemplate[] }>(
          `${BASE}/templates?connectionId=${encodeURIComponent(connectionId)}&source=${encodeURIComponent(source)}`
        )
        .then((r) => r.data),
    queryKey: [...key(connectionId), 'templates', source],
  });
}

export function useAutomationFires(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api
        .get<{ data: { fires: AutomationFire[] } }>(`${BASE}/${id}/fires?limit=20`)
        .then((r) => r.data.fires),
    queryKey: ['automations', 'fires', id],
  });
}

/** Everything that lists automations: the repository's, and the cross-kind list. */
function useInvalidate(connectionId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: key(connectionId) }),
      qc.invalidateQueries({ queryKey: ['automations', 'all'] }),
    ]);
}

export function useCreateEventAutomation(connectionId: string) {
  const invalidate = useInvalidate(connectionId);
  return useMutation({
    mutationFn: (body: EventAutomationInput & { source: string }) =>
      api.post(BASE, { ...body, connectionId }),
    onSuccess: invalidate,
  });
}

export function useUpdateEventAutomation(connectionId: string) {
  const invalidate = useInvalidate(connectionId);
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<EventAutomationInput> & { id: string }) =>
      api.patch(`${BASE}/${id}`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteEventAutomation(connectionId: string) {
  const invalidate = useInvalidate(connectionId);
  return useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/${id}`),
    onSuccess: invalidate,
  });
}

/** The kinds the cross-kind list holds; schedules come from their own route and are merged in. */
export type AutomationKind = 'event' | 'schedule' | 'template_webhook' | 'tracker_transition';

/** One automation of any kind, normalised for the Automations page. */
export interface AutomationSummary {
  kind: AutomationKind;
  id: string;
  name: string;
  enabled: boolean;
  /** When it fires, in words. */
  when: string;
  repository: { id: string; organizationName: string | null; repoName: string | null } | null;
  team: { id: string; name: string } | null;
  template: { id: string; name: string } | null;
  canManage: boolean;
  /** The latest decision or run, with its outcome or status. */
  lastActivity: { at: string; outcome: string } | null;
  /** For `event`: the automation itself. */
  automation?: EventAutomation;
  /** For `event`: its source key. */
  source?: string;
}

/** Event automations, template webhooks and (ADMIN) the tracker hook the caller may see. */
export function useAllAutomations() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: AutomationSummary[] }>('/api/v1/automations').then((r) => r.data),
    queryKey: ['automations', 'all'],
  });
}
