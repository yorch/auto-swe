'use client';

import type {
  OrchestrationChildDto,
  OrchestrationDetailDto,
  OrchestrationMessageDto,
} from '@auto-swe/shared/lib/orchestrationApi';
import { SseParser } from '@auto-swe/shared/lib/sse';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  type MessagesState,
  mergeMessages,
  type OrchestrationStreamState,
  orchestrationKey,
  orchestrationMessagesKey,
  orchestrationStreamKey,
} from '@/hooks/useOrchestrations';
import { api } from '@/lib/api';
import { API_BASE } from '@/lib/config';
import { isRecord } from '@/lib/utils';

/**
 * Live updates for one orchestration over `GET /api/v1/orchestrations/:id/events`.
 *
 * The stream is a fetch, not an `EventSource`: an `EventSource` cannot send the bearer token or
 * choose `Last-Event-ID`. Events are written into the TanStack caches the polling hooks own, so
 * the polling hooks keep working unchanged; while this stream delivers they slow to a safety
 * interval, and whenever it cannot (an HTTP refusal, a 429, a proxy that does not stream, silence)
 * they return to their 3 s polling.
 */

/** No byte (event or heartbeat) for this long: the stream is treated as dead. */
export const STREAM_SILENCE_MS = 45_000;
/** The reconnect delay before the server's `retry:` hint, and its cap. */
export const STREAM_BACKOFF_BASE_MS = 1_000;
export const STREAM_BACKOFF_MAX_MS = 30_000;
/** How long to wait before trying again after a refusal that waiting may clear (429, 5xx). */
export const STREAM_BUSY_RETRY_MS = 30_000;
/** A server that does not stream (a buffering proxy, a 4xx other than 429): tries before giving up. */
export const STREAM_UNSUPPORTED_TRIES = 3;
export const STREAM_UNSUPPORTED_RETRY_MS = 60_000;
/** Failures shown as "reconnecting" before the indicator says "polling". */
const RECONNECTING_FAILURES = 3;
/**
 * A change that alters what the detail shows beyond one child's own row (a status event, a new
 * child, or a child's status, run or result changing) is folded into one re-read of the detail.
 */
const DETAIL_REFRESH_MS = 1_500;
/**
 * A `child` event that only moves a number (cost, steering count) patches the cache and nothing
 * else; the figures derived from it (budget readout) are re-read at most this often.
 */
export const DETAIL_QUIET_REFRESH_MS = 15_000;

/** Full jitter over the upper half of a delay: never zero, never more than the delay. */
function jitter(ms: number): number {
  return Math.round(ms * (0.5 + Math.random() * 0.5));
}

type Outcome =
  | { kind: 'aborted' }
  | { kind: 'done' }
  | { kind: 'ended' }
  | { kind: 'error' }
  | { kind: 'silent' }
  | { kind: 'refused'; status: number }
  | { kind: 'unsupported' };

/** Wait `ms`, or until `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function applyMessage(qc: QueryClient, id: string, message: OrchestrationMessageDto): boolean {
  let applied = false;
  qc.setQueryData<MessagesState>(orchestrationMessagesKey(id), (prev) => {
    if (!prev) {
      return prev;
    }
    applied = true;
    const merged = mergeMessages(prev.messages, [message]);
    // The polling cursor is left alone: the next poll re-reads from it and merges by id, so a
    // message that reached the cache by either path is never lost to the other.
    return merged === prev.messages ? prev : { ...prev, messages: merged };
  });
  return applied;
}

/**
 * Patch one child into the cached detail, its cost included, and say whether the change is one the
 * detail's other fields depend on: a child not held yet, or a different status, run or result.
 * A change in cost or steering count alone is not.
 */
function applyChild(qc: QueryClient, id: string, child: OrchestrationChildDto): boolean {
  let structural = false;
  qc.setQueryData<OrchestrationDetailDto>(orchestrationKey(id), (prev) => {
    if (!prev) {
      return prev;
    }
    const before = prev.children.find((c) => c.id === child.id);
    structural =
      !before ||
      before.status !== child.status ||
      before.runId !== child.runId ||
      JSON.stringify(before.result) !== JSON.stringify(child.result);
    const children = before
      ? prev.children.map((c) => (c.id === child.id ? { ...c, ...child } : c))
      : [...prev.children, child];
    const childrenUsd = children.reduce((sum, c) => sum + c.costUsd, 0);
    return {
      ...prev,
      children,
      cost: {
        ...prev.cost,
        childrenUsd,
        totalUsd: childrenUsd + prev.cost.orchestratorUsd,
      },
    };
  });
  return structural;
}

function applyStatus(qc: QueryClient, id: string, status: OrchestrationDetailDto['status']) {
  qc.setQueryData<OrchestrationDetailDto>(orchestrationKey(id), (prev) =>
    prev && prev.status !== status ? { ...prev, status } : prev
  );
}

/**
 * Follow `id` while `enabled` (the orchestration is live and the page is mounted). Returns the
 * stream's state for the indicator. Reconnects with exponential backoff and jitter, resuming
 * from the last event id; pauses while the tab is hidden and catches up when it returns.
 */
export function useOrchestrationStream(id: string, enabled: boolean): OrchestrationStreamState {
  const qc = useQueryClient();
  const [state, setState] = useState<OrchestrationStreamState>('idle');

  useEffect(() => {
    if (!id || !enabled || typeof fetch === 'undefined') {
      qc.setQueryData(orchestrationStreamKey(id), 'idle');
      setState('idle');
      return;
    }
    const life = new AbortController();
    let current: OrchestrationStreamState = 'idle';
    let conn: AbortController | null = null;
    let wake: (() => void) | null = null;
    let detailTimer: ReturnType<typeof setTimeout> | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    // The page has just read the detail, so a quiet refresh is measured from now.
    let lastDetailRead = Date.now();

    const catchUp = () => {
      void qc.invalidateQueries({ queryKey: orchestrationKey(id) });
      void qc.invalidateQueries({ queryKey: orchestrationMessagesKey(id) });
    };
    const publish = (next: OrchestrationStreamState) => {
      if (next === current) {
        return;
      }
      const wasLive = current === 'live';
      current = next;
      qc.setQueryData(orchestrationStreamKey(id), next);
      setState(next);
      // Leaving 'live' hands the page back to its 3 s polling: read now rather than wait out a
      // pending 30 s tick.
      if (wasLive && next !== 'paused') {
        catchUp();
      }
    };
    const readDetail = () => {
      detailTimer = undefined;
      clearTimeout(quietTimer);
      quietTimer = undefined;
      lastDetailRead = Date.now();
      void qc.invalidateQueries({ queryKey: orchestrationKey(id) });
    };
    // A change the detail's other fields depend on: one read, debounced.
    const scheduleDetailRefresh = () => {
      if (detailTimer === undefined) {
        detailTimer = setTimeout(readDetail, DETAIL_REFRESH_MS);
      }
    };
    // A number moved (a child's cost): the cache already shows it; the derived figures catch up
    // at most once per DETAIL_QUIET_REFRESH_MS.
    const scheduleQuietRefresh = () => {
      if (detailTimer === undefined && quietTimer === undefined) {
        const wait = Math.max(0, lastDetailRead + DETAIL_QUIET_REFRESH_MS - Date.now());
        quietTimer = setTimeout(readDetail, wait);
      }
    };
    const hidden = () => typeof document !== 'undefined' && document.hidden;
    const onVisibility = () => {
      if (hidden()) {
        conn?.abort();
        return;
      }
      catchUp();
      wake?.();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const waitVisible = () =>
      new Promise<void>((resolve) => {
        wake = () => {
          wake = null;
          resolve();
        };
        life.signal.addEventListener('abort', () => wake?.(), { once: true });
      });

    const connect = async (lastEventId: string, onLive: () => void): Promise<Outcome> => {
      const ctl = new AbortController();
      conn = ctl;
      const onLife = () => ctl.abort();
      life.signal.addEventListener('abort', onLife, { once: true });
      let silent = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          silent = true;
          ctl.abort();
        }, STREAM_SILENCE_MS);
      };
      const open = async (): Promise<Response> => {
        const token = api.getToken();
        return fetch(`${API_BASE}/api/v1/orchestrations/${encodeURIComponent(id)}/events`, {
          cache: 'no-store',
          credentials: 'include',
          headers: {
            Accept: 'text/event-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
          },
          signal: ctl.signal,
        });
      };
      try {
        arm();
        let res = await open();
        if (res.status === 401 && api.getToken() && (await api.refreshToken())) {
          res = await open();
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return { kind: 'refused', status: res.status };
        }
        if (!(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) {
          await res.body?.cancel().catch(() => undefined);
          return { kind: 'unsupported' };
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        let first = true;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            return { kind: 'ended' };
          }
          arm();
          if (first) {
            first = false;
            onLive();
          }
          const parsed = parser.push(decoder.decode(value, { stream: true }));
          if (parsed.retry !== undefined) {
            retryHint = parsed.retry;
          }
          for (const ev of parsed.events) {
            if (ev.id) {
              lastId = ev.id;
            }
            if (ev.event === 'done') {
              return { kind: 'done' };
            }
            let data: unknown;
            try {
              data = JSON.parse(ev.data);
            } catch {
              continue;
            }
            if (!isRecord(data)) {
              continue;
            }
            failures = 0;
            if (ev.event === 'message' && typeof data.id === 'string') {
              if (!applyMessage(qc, id, data as unknown as OrchestrationMessageDto)) {
                scheduleDetailRefresh();
              }
            } else if (ev.event === 'child' && typeof data.id === 'string') {
              if (applyChild(qc, id, data as unknown as OrchestrationChildDto)) {
                scheduleDetailRefresh();
              } else {
                scheduleQuietRefresh();
              }
            } else if (ev.event === 'status' && typeof data.status === 'string') {
              applyStatus(qc, id, data.status as OrchestrationDetailDto['status']);
              scheduleDetailRefresh();
            }
          }
        }
      } catch {
        if (silent) {
          return { kind: 'silent' };
        }
        return life.signal.aborted || ctl.signal.aborted ? { kind: 'aborted' } : { kind: 'error' };
      } finally {
        clearTimeout(timer);
        life.signal.removeEventListener('abort', onLife);
        ctl.abort();
        if (conn === ctl) {
          conn = null;
        }
      }
    };

    // Loop state shared with `connect`: the resume cursor, the server's retry hint, and the
    // failures in a row since the last event.
    let lastId = '';
    let retryHint: number | undefined;
    let failures = 0;
    let everConnected = false;

    const run = async () => {
      let unsupported = 0;
      while (!life.signal.aborted) {
        if (hidden()) {
          publish('paused');
          await waitVisible();
          if (life.signal.aborted) {
            break;
          }
          failures = 0;
        }
        publish(everConnected || failures > 0 ? 'reconnecting' : 'connecting');
        // Resume from where this stream stopped, else from the polled transcript's cursor.
        const resume =
          lastId || (qc.getQueryData<MessagesState>(orchestrationMessagesKey(id))?.next ?? '');
        const outcome = await connect(resume, () => {
          everConnected = true;
          publish('live');
        });
        if (life.signal.aborted) {
          break;
        }
        if (outcome.kind === 'aborted') {
          // The tab was hidden mid-stream; the loop top pauses.
          continue;
        }
        if (outcome.kind === 'done') {
          // The server's time limit: not a failure; reconnect at once from the last id.
          continue;
        }
        let delay: number;
        if (outcome.kind === 'refused' || outcome.kind === 'unsupported') {
          publish('polling');
          const retryable =
            outcome.kind === 'refused' && (outcome.status === 429 || outcome.status >= 500);
          if (retryable) {
            failures += 1;
            delay = jitter(STREAM_BUSY_RETRY_MS);
          } else {
            unsupported += 1;
            if (unsupported >= STREAM_UNSUPPORTED_TRIES) {
              // A proxy that buffers or a route that is refused will not change on retry; polling
              // carries the page, and a returning tab starts the attempts afresh.
              publish('polling');
              await waitVisibleAgain();
              unsupported = 0;
              continue;
            }
            delay = jitter(STREAM_UNSUPPORTED_RETRY_MS);
          }
        } else {
          failures += 1;
          const base = Math.max(STREAM_BACKOFF_BASE_MS, retryHint ?? 0);
          delay = jitter(Math.min(STREAM_BACKOFF_MAX_MS, base * 2 ** Math.min(failures - 1, 10)));
          publish(
            outcome.kind === 'silent' || failures > RECONNECTING_FAILURES
              ? 'polling'
              : 'reconnecting'
          );
        }
        await pause(delay, life.signal);
      }
    };

    // After giving up on a server that does not stream: wait for the tab to be hidden and shown
    // again, or for the page to leave.
    const waitVisibleAgain = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          document.removeEventListener('visibilitychange', check);
          resolve();
        };
        let wasHidden = false;
        const check = () => {
          if (document.hidden) {
            wasHidden = true;
          } else if (wasHidden) {
            done();
          }
        };
        document.addEventListener('visibilitychange', check);
        life.signal.addEventListener('abort', done, { once: true });
      });

    void run();

    return () => {
      life.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(detailTimer);
      clearTimeout(quietTimer);
      qc.setQueryData(orchestrationStreamKey(id), 'idle');
      // The page stops following (finished, or leaving): one last read of the detail so the
      // closing state is not left to a polling hook that has stopped.
      void qc.invalidateQueries({ queryKey: orchestrationKey(id) });
    };
  }, [id, enabled, qc]);

  return enabled ? state : 'idle';
}
