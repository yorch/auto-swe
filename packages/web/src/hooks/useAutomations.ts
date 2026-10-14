'use client';

import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** An event automation (docs/automations.md), as the API returns it. */
export interface EventAutomation {
  id: string;
  /** Its repository; null for a team's automation. */
  connectionId: string | null;
  /** Its team, for an automation with no repository. */
  teamId?: string | null;
  team?: { id: string; name: string } | null;
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
  /** Set when the decision was taken again; a newer row holds the outcome. */
  retriedAt: string | null;
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

/** What event automations belong to: a repository, or a team (for a team-target source). */
export type AutomationOwner = { connectionId: string } | { teamId: string };

/** The owner as the API's query and body name it. */
function ownerParam(owner: AutomationOwner): { connectionId: string } | { teamId: string } {
  return 'connectionId' in owner ? { connectionId: owner.connectionId } : { teamId: owner.teamId };
}

function ownerQuery(owner: AutomationOwner): string {
  return 'connectionId' in owner
    ? `connectionId=${encodeURIComponent(owner.connectionId)}`
    : `teamId=${encodeURIComponent(owner.teamId)}`;
}

const BASE = '/api/v1/automations/events';
const key = (owner: AutomationOwner) => [
  'automations',
  'events',
  'connectionId' in owner ? owner.connectionId : `team:${owner.teamId}`,
];

export function useEventAutomations(owner: AutomationOwner) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: { canManage: boolean; automations: EventAutomation[] } }>(
          `${BASE}?${ownerQuery(owner)}`
        )
        .then((r) => r.data),
    queryKey: key(owner),
  });
}

export function useAutomationTemplates(owner: AutomationOwner, source: string, enabled = true) {
  return useQuery({
    enabled,
    queryFn: () =>
      api
        .get<{ data: AutomationTemplate[] }>(
          `${BASE}/templates?${ownerQuery(owner)}&source=${encodeURIComponent(source)}`
        )
        .then((r) => r.data),
    queryKey: [...key(owner), 'templates', source],
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

/** Take a decision that started no run again, now; every limit applies. */
export function useRetryAutomationFire(automationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fireId: string) =>
      api
        .post<{ data: { outcome?: string; reason?: string } }>(
          `${BASE}/${automationId}/fires/${fireId}/retry`,
          {}
        )
        .then((r) => r.data),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['automations', 'fires', automationId] }),
        qc.invalidateQueries({ queryKey: ['automations', 'all'] }),
      ]),
  });
}

/** Everything that lists automations: the owner's, and the cross-kind list. */
function useInvalidate(owner: AutomationOwner) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: key(owner) }),
      qc.invalidateQueries({ queryKey: ['automations', 'all'] }),
    ]);
}

export function useCreateEventAutomation(owner: AutomationOwner) {
  const invalidate = useInvalidate(owner);
  return useMutation({
    mutationFn: (body: EventAutomationInput & { source: string }) =>
      api.post(BASE, { ...body, ...ownerParam(owner) }),
    onSuccess: invalidate,
  });
}

export function useUpdateEventAutomation(owner: AutomationOwner) {
  const invalidate = useInvalidate(owner);
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<EventAutomationInput> & { id: string }) =>
      api.patch(`${BASE}/${id}`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteEventAutomation(owner: AutomationOwner) {
  const invalidate = useInvalidate(owner);
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
  /** A decision (outcome, and why when it started nothing), or a run's status. */
  lastActivity: { at: string; outcome: string; reason?: string | null } | null;
  /** For `event`: the automation itself. */
  automation?: EventAutomation;
  /** For `event`: its source key. */
  source?: string;
  /** For `template_webhook`: a signing secret exists. */
  signed?: boolean;
  /** For `template_webhook`: unsigned calls are refused (the template's switch or policy). */
  signatureRequired?: boolean;
}

/** Event automations, template webhooks and (ADMIN) the tracker hook the caller may see. */
export function useAllAutomations() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: AutomationSummary[] }>('/api/v1/automations').then((r) => r.data),
    queryKey: ['automations', 'all'],
  });
}
