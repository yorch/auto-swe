'use client';

import type {
  OrchestrationDetailDto,
  OrchestrationLaunchResponse,
  OrchestrationMessageDto,
  OrchestrationMessagesPage,
  OrchestrationSummaryDto,
} from '@auto-swe/shared/lib/orchestrationApi';
import type { AgentRunAgent } from '@auto-swe/shared/types/api';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { ME_SUMMARY_KEY } from '@/hooks/useMeSummary';
import { api } from '@/lib/api';
import { isOrchestrationLive } from '@/lib/orchestration';
import { randomId } from '@/lib/randomId';

const BASE = '/api/v1/orchestrations';

/** How often a live orchestration is re-read. TanStack pauses it while the tab is hidden. */
export const ORCHESTRATION_POLL_MS = 3_000;

export const orchestrationsKey = ['orchestrations'] as const;
export const orchestrationKey = (id: string) => ['orchestration', id] as const;
export const orchestrationMessagesKey = (id: string) => ['orchestration-messages', id] as const;

/** The interval for a status: none once the orchestration is finished or not yet known. */
export function orchestrationRefetchInterval(
  status: OrchestrationDetailDto['status'] | undefined
): number | false {
  return isOrchestrationLive(status) ? ORCHESTRATION_POLL_MS : false;
}

export function useOrchestrations() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: OrchestrationSummaryDto[] }>(`${BASE}?limit=100`).then((r) => r.data),
    queryKey: orchestrationsKey,
    // Rows move between active and finished; there is no per-row status to key a stop on.
    refetchInterval: (q) =>
      q.state.data?.some((o) => isOrchestrationLive(o.status)) ? ORCHESTRATION_POLL_MS * 2 : false,
  });
}

export function useOrchestration(id: string) {
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api
        .get<{ data: OrchestrationDetailDto }>(`${BASE}/${encodeURIComponent(id)}`)
        .then((r) => r.data),
    queryKey: orchestrationKey(id),
    refetchInterval: (q) => orchestrationRefetchInterval(q.state.data?.status),
  });
}

export interface MessagesState {
  messages: OrchestrationMessageDto[];
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

/**
 * The transcript. The first read takes everything; each poll passes the previous page's `next`
 * as `after` and appends what comes back to the cached list, so a long conversation is not
 * re-downloaded every few seconds. `live` stops the polling once the orchestration is finished,
 * with one last read so the closing messages are not missed.
 */
export function useOrchestrationMessages(id: string, live: boolean) {
  const qc = useQueryClient();
  const query = useQuery<MessagesState>({
    enabled: !!id,
    queryFn: async () => {
      const held = qc.getQueryData<MessagesState>(orchestrationMessagesKey(id));
      const qs = held?.next ? `?after=${encodeURIComponent(held.next)}` : '';
      const page = await api.get<OrchestrationMessagesPage>(
        `${BASE}/${encodeURIComponent(id)}/messages${qs}`
      );
      return {
        messages: mergeMessages(held?.messages ?? [], page.data),
        next: page.next ?? held?.next ?? null,
      };
    },
    queryKey: orchestrationMessagesKey(id),
    refetchInterval: live ? ORCHESTRATION_POLL_MS : false,
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

function refresh(qc: QueryClient, id: string) {
  void qc.invalidateQueries({ queryKey: orchestrationKey(id) });
  void qc.invalidateQueries({ queryKey: orchestrationMessagesKey(id) });
  void qc.invalidateQueries({ queryKey: orchestrationsKey });
}

function useOrchestrationAction<V>(id: string, run: (variables: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => refresh(qc, id),
  });
}

const path = (id: string, suffix: string) => `${BASE}/${encodeURIComponent(id)}${suffix}`;

/** A human message to the orchestrator. Launcher only. */
export function useSendOrchestrationMessage(id: string) {
  return useOrchestrationAction(id, (body: string) => api.post(path(id, '/messages'), { body }));
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
