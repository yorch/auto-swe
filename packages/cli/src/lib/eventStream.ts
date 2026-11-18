import { type SseEvent, SseLimitError, SseParser } from '@auto-swe/shared/lib/sse';
import type { CliEnv } from './env.js';

/**
 * Read a server-sent event stream with Node's streaming `fetch` and the shared parser
 * (`@auto-swe/shared/lib/sse`). The caller decides what an event means: this only opens the stream,
 * resumes from `Last-Event-ID`, hands the events over in batches, and reports how it ended.
 */

/** No byte (event or heartbeat) for this long: the stream is dead. The gateway pings every 15 s. */
export const STREAM_SILENCE_MS = 45_000;

export interface EventStreamOptions {
  /** Sent as `Last-Event-ID`; the server replays everything after it. */
  lastEventId?: string;
  signal: AbortSignal;
  silenceMs?: number;
  /** Called with each chunk's events, in order. Return true to stop reading. */
  onBatch: (events: SseEvent[]) => Promise<boolean>;
}

export type EventStreamResult =
  /** No stream: a refusal (429, 404…), a non-event-stream answer, or no connection at all. */
  | { kind: 'unavailable'; reason: string }
  /** The caller's `onBatch` asked to stop. */
  | { kind: 'stopped'; lastEventId: string }
  /** The server ended the stream at its time limit (`done`): reconnect at once. */
  | { kind: 'done'; lastEventId: string }
  /** The connection closed or failed after it had been established. */
  | { kind: 'ended' | 'silent' | 'error'; lastEventId: string }
  | { kind: 'aborted'; lastEventId: string };

export async function consumeEventStream(
  env: CliEnv,
  path: string,
  opts: EventStreamOptions
): Promise<EventStreamResult> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (opts.signal.aborted) {
    return { kind: 'aborted', lastEventId: opts.lastEventId ?? '' };
  }
  opts.signal.addEventListener('abort', onAbort, { once: true });
  let silent = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      silent = true;
      ctl.abort();
    }, opts.silenceMs ?? STREAM_SILENCE_MS);
  };
  const parser = new SseParser();
  const last = () => parser.lastEventId || opts.lastEventId || '';
  let established = false;
  try {
    arm();
    let res: Response;
    try {
      res = await fetch(`${env.apiUrl}${path}`, {
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${env.token}`,
          ...(opts.lastEventId ? { 'Last-Event-ID': opts.lastEventId } : {}),
        },
        signal: ctl.signal,
      });
    } catch (err) {
      if (opts.signal.aborted) {
        return { kind: 'aborted', lastEventId: last() };
      }
      return { kind: 'unavailable', reason: silent ? 'no answer' : String(err) };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'unavailable', reason: `HTTP ${res.status}` };
    }
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'unavailable', reason: 'not an event stream' };
    }
    established = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return { kind: 'ended', lastEventId: last() };
      }
      arm();
      const { events } = parser.push(decoder.decode(value, { stream: true }));
      if (events.length === 0) {
        continue;
      }
      const cut = events.findIndex((e) => e.event === 'done');
      const delivered = cut === -1 ? events : events.slice(0, cut);
      if (delivered.length > 0 && (await opts.onBatch(delivered))) {
        return { kind: 'stopped', lastEventId: last() };
      }
      if (cut !== -1) {
        return { kind: 'done', lastEventId: last() };
      }
    }
  } catch (err) {
    if (opts.signal.aborted) {
      return { kind: 'aborted', lastEventId: last() };
    }
    if (silent) {
      return { kind: 'silent', lastEventId: last() };
    }
    if (!established) {
      return { kind: 'unavailable', reason: String(err) };
    }
    // An error thrown by the caller's own handler is not a stream failure: let it surface.
    if (
      err instanceof SseLimitError ||
      err instanceof TypeError ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      return { kind: 'error', lastEventId: last() };
    }
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onAbort);
    ctl.abort();
  }
}
