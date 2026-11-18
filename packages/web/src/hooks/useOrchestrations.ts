'use client';

import type {
  OrchestrationConnectionOption,
  OrchestrationDefaults,
  OrchestrationDetailDto,
  OrchestrationLaunchResponse,
  OrchestrationMessageDto,
  OrchestrationMessagesPage,
  OrchestrationSummaryDto,
} from '@auto-swe/shared/lib/orchestrationApi';
import type { AgentRunAgent } from '@auto-swe/shared/types/api';
import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { ME_SUMMARY_KEY } from '@/hooks/useMeSummary';
import { api } from '@/lib/api';
import { isOrchestrationLive, restartsOnMessage } from '@/lib/orchestration';
import { randomId } from '@/lib/randomId';

const BASE = '/api/v1/orchestrations';

/** How often a live orchestration is re-read. TanStack pauses it while the tab is hidden. */
export const ORCHESTRATION_POLL_MS = 3_000;

/** How often a live orchestration is re-read while its event stream is healthy: a safety net. */
export const ORCHESTRATION_SAFETY_POLL_MS = 30_000;

/** The state of an orchestration's event stream (see `useOrchestrationStream`). */
export type OrchestrationStreamState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'polling'
  | 'paused';

export const orchestrationsKey = ['orchestrations'] as const;
export const orchestrationStreamKey = (id: string) => ['orchestration-stream', id] as const;
export const orchestrationKey = (id: string) => ['orchestration', id] as const;
export const orchestrationMessagesKey = (id: string) => ['orchestration-messages', id] as const;

/** The poll interval for a live orchestration: slow while its stream delivers, else 3 s. */
function liveInterval(qc: QueryClient, id: string): number {
  return qc.getQueryData<OrchestrationStreamState>(orchestrationStreamKey(id)) === 'live'
    ? ORCHESTRATION_SAFETY_POLL_MS
    : ORCHESTRATION_POLL_MS;
}

/** The interval for a status: none once the orchestration is finished or not yet known. */
export function orchestrationRefetchInterval(
  status: OrchestrationDetailDto['status'] | undefined
): number | false {
  return isOrchestrationLive(status) ? ORCHESTRATION_POLL_MS : false;
}

export const ORCHESTRATIONS_PAGE_SIZE = 25;

export interface OrchestrationsPage {
  rows: OrchestrationSummaryDto[];
  total: number;
}

/** One page of the list, newest update first. The previous page stays on screen while the next loads. */
export function useOrchestrations(offset = 0, limit = ORCHESTRATIONS_PAGE_SIZE) {
  return useQuery({
    placeholderData: keepPreviousData,
    queryFn: () =>
      api
        .get<{ data: OrchestrationSummaryDto[]; total?: number }>(
          `${BASE}?limit=${limit}&offset=${offset}`
        )
        .then((r): OrchestrationsPage => ({ rows: r.data, total: r.total ?? r.data.length })),
    queryKey: [...orchestrationsKey, offset, limit],
    // Rows move between active and finished; there is no per-row status to key a stop on.
    refetchInterval: (q) =>
      q.state.data?.rows.some((o) => isOrchestrationLive(o.status))
        ? ORCHESTRATION_POLL_MS * 2
        : false,
  });
}

/** How long after a message restarts a finished orchestration its status is re-read. */
export const RESTART_WATCH_MS = 30_000;
const restartKey = (id: string) => ['orchestration-restarting', id] as const;

export function useOrchestration(id: string) {
  const qc = useQueryClient();
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api
        .get<{ data: OrchestrationDetailDto }>(`${BASE}/${encodeURIComponent(id)}`)
        .then((r) => r.data),
    queryKey: orchestrationKey(id),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (isOrchestrationLive(status)) {
        return liveInterval(qc, id);
      }
      // A message sent to a finished orchestration restarts it; keep reading until it shows.
      const until = qc.getQueryData<number>(restartKey(id)) ?? 0;
      return until > Date.now() ? ORCHESTRATION_POLL_MS : false;
    },
  });
}

export interface MessagesState {
  messages: OrchestrationMessageDto[];
  /** True when the last fetch stopped at its page bound with more waiting. */
  more?: boolean;
  /** The cursor for the next read; null until a message has been seen. */
  next: string | null;
}

/** Append newly read messages, dropping ones already held (by id), oldest first. */
export function mergeMessages(
  held: readonly OrchestrationMessageDto[],
  incoming: readonly OrchestrationMessageDto[]
): OrchestrationMessageDto[] {
  const seen = new Set(held.map((m) => m.id));
  const fresh = incoming.filter((m) => !seen.has(m.id));
  if (fresh.length === 0) {
    return held as OrchestrationMessageDto[];
  }
  // A stable sort: messages with the same timestamp keep the order the server returned.
  return [...held, ...fresh].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Messages asked for per request, the gateway's maximum. */
export const MESSAGES_PAGE_SIZE = 200;
/** A bound on one fetch; a longer transcript is finished by the follow-up reads. */
export const MESSAGES_MAX_PAGES = 20;

/**
 * The transcript. The first read takes everything, following the cursor while a page comes back
 * full; each poll passes the previous cursor as `after` and appends what comes back, so a long
 * conversation is not re-downloaded every few seconds. `live` stops the polling once the
 * orchestration is finished, with one last read (which drains every page) so the closing
 * messages are not missed.
 */
export function useOrchestrationMessages(id: string, live: boolean) {
  const qc = useQueryClient();
  const query = useQuery<MessagesState>({
    enabled: !!id,
    queryFn: async () => {
      const held = qc.getQueryData<MessagesState>(orchestrationMessagesKey(id));
      let cursor = held?.next ?? null;
      let more = false;
      const fetched: OrchestrationMessageDto[] = [];
      for (let pages = 0; pages < MESSAGES_MAX_PAGES; pages += 1) {
        const qs = `?limit=${MESSAGES_PAGE_SIZE}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
        const page = await api.get<OrchestrationMessagesPage>(
          `${BASE}/${encodeURIComponent(id)}/messages${qs}`
        );
        fetched.push(...page.data);
        cursor = page.next ?? cursor;
        if (page.data.length < MESSAGES_PAGE_SIZE) {
          break;
        }
        more = pages === MESSAGES_MAX_PAGES - 1;
      }
      // Merge into what the cache holds NOW, not what it held when the poll began: the stream may
      // have written a message while the requests were in flight, and replacing the cache with a
      // state built from the earlier snapshot would drop it.
      const current = qc.getQueryData<MessagesState>(orchestrationMessagesKey(id));
      return {
        messages: mergeMessages(current?.messages ?? held?.messages ?? [], fetched),
        more,
        next: cursor,
      };
    },
    queryKey: orchestrationMessagesKey(id),
    // A fetch that hit its page bound continues straight away, live or not.
    refetchInterval: (q) => (q.state.data?.more ? 250 : live ? liveInterval(qc, id) : false),
  });
  const wasLive = useRef(live);
  const refetch = query.refetch;
  useEffect(() => {
    if (wasLive.current && !live) {
      void refetch();
    }
    wasLive.current = live;
  }, [live, refetch]);
  return query;
}

/** Launchable agents for the allowlist; unlike the agent form, a repository is optional. */
export function useOrchestrationAgents(repoId: string | null) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: AgentRunAgent[] }>(
          `/api/v1/agent-runs/agents${repoId ? `?repoId=${encodeURIComponent(repoId)}` : ''}`
        )
        .then((r) => r.data),
    queryKey: ['orchestration-agents', repoId],
  });
}

/**
 * The MCP connections a launcher may put in the fixed set for a team. Open to any ENGINEER who is
 * a member of the team, unlike the platform list, which is ADMIN-only.
 */
export function useOrchestrationConnections(teamId: string) {
  return useQuery({
    enabled: !!teamId,
    queryFn: () =>
      api
        .get<{ data: OrchestrationConnectionOption[] }>(
          `${BASE}/connections?teamId=${encodeURIComponent(teamId)}`
        )
        .then((r) => r.data),
    queryKey: ['orchestration-connections', teamId],
  });
}

/**
 * The allowlist a launch with none named would apply for a team: the operator's default, reduced
 * to agents the caller could start, and which of them can change files as the team's organization
 * resolves them. Open to any member of the team.
 */
export function useOrchestrationDefaults(teamId: string) {
  return useQuery({
    enabled: !!teamId,
    queryFn: () =>
      api
        .get<{ data: OrchestrationDefaults }>(
          `${BASE}/defaults?teamId=${encodeURIComponent(teamId)}`
        )
        .then((r) => ({ allowlist: r.data.allowlist, writeCapable: r.data.writeCapable ?? [] })),
    queryKey: ['orchestration-defaults', teamId],
  });
}

function refresh(qc: QueryClient, id: string) {
  void qc.invalidateQueries({ queryKey: orchestrationKey(id) });
  void qc.invalidateQueries({ queryKey: orchestrationMessagesKey(id) });
  void qc.invalidateQueries({ queryKey: orchestrationsKey });
}

function useOrchestrationAction<V>(
  id: string,
  run: (variables: V) => Promise<unknown>,
  onSuccess?: (qc: QueryClient) => void
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => refresh(qc, id),
    onSuccess: () => onSuccess?.(qc),
  });
}

const path = (id: string, suffix: string) => `${BASE}/${encodeURIComponent(id)}${suffix}`;

/** A human message to the orchestrator. Launcher only. */
export function useSendOrchestrationMessage(id: string) {
  return useOrchestrationAction(
    id,
    (body: string) => api.post(path(id, '/messages'), { body }),
    (qc) => {
      // A message to a COMPLETED orchestration restarts it: watch the status until it shows.
      const status = qc.getQueryData<OrchestrationDetailDto>(orchestrationKey(id))?.status;
      if (status && restartsOnMessage(status)) {
        qc.setQueryData(restartKey(id), Date.now() + RESTART_WATCH_MS);
      }
    }
  );
}

/** A human message to one child. Launcher only. */
export function useMessageChild(id: string) {
  return useOrchestrationAction(id, ({ body, childId }: { body: string; childId: string }) =>
    api.post(path(id, `/children/${encodeURIComponent(childId)}/messages`), { body })
  );
}

export function useCancelChild(id: string) {
  return useOrchestrationAction(id, (childId: string) =>
    api.post(path(id, `/children/${encodeURIComponent(childId)}/cancel`), {})
  );
}

/** Attach the one repository. The only thing that attaches; launcher only. */
export function useAttachRepo(id: string) {
  return useOrchestrationAction(id, (repoId: string) => api.post(path(id, '/attach'), { repoId }));
}

export function useDeclineAttach(id: string) {
  return useOrchestrationAction<void>(id, () => api.post(path(id, '/attach/decline'), {}));
}

export function useDecideApproval(id: string) {
  return useOrchestrationAction(
    id,
    ({ approvalId, decision }: { approvalId: string; decision: 'APPROVE' | 'DENY' }) =>
      api.post(path(id, `/approvals/${encodeURIComponent(approvalId)}`), { decision })
  );
}

export function useCancelOrchestration(id: string) {
  return useOrchestrationAction<void>(id, () => api.post(path(id, '/cancel'), {}));
}

export function useEndOrchestration(id: string) {
  return useOrchestrationAction<void>(id, () => api.post(path(id, '/end'), {}));
}

export function useLaunchOrchestration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      body,
      idempotencyKey = randomId(),
    }: {
      body: Record<string, unknown>;
      idempotencyKey?: string;
    }) =>
      api
        .fetch<{ data: OrchestrationLaunchResponse }>(BASE, {
          body: JSON.stringify(body),
          headers: { 'Idempotency-Key': idempotencyKey },
          method: 'POST',
        })
        .then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orchestrationsKey });
      void qc.invalidateQueries({ queryKey: ME_SUMMARY_KEY });
    },
  });
}
