import type { AgentTraceRecord } from '@auto-swe/shared/types/api';

/** The trace kinds the stream can be narrowed to; `all` is no narrowing. */
export type TraceKindFilter = 'all' | 'llm_response' | 'tool_call' | 'activity_event';

export interface TraceFilter {
  /** Matched case-insensitively against a trace's names, error and payloads. */
  query: string;
  kind: TraceKindFilter;
  errorsOnly: boolean;
}

export const NO_TRACE_FILTER: TraceFilter = { errorsOnly: false, kind: 'all', query: '' };

/** The most events the stream renders at once; the rest sit behind a "show more" step. */
export const TRACE_RENDER_LIMIT = 400;

export function isTraceFilterActive(filter: TraceFilter): boolean {
  return filter.errorsOnly || filter.kind !== 'all' || filter.query.trim() !== '';
}

const searchTextCache = new WeakMap<AgentTraceRecord, string>();

function stringify(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** Everything a text search looks at, lower-cased once per record. */
export function traceSearchText(trace: AgentTraceRecord): string {
  let text = searchTextCache.get(trace);
  if (text === undefined) {
    text = [
      trace.toolName,
      trace.agentKey,
      trace.model,
      trace.nodeId,
      trace.error,
      stringify(trace.inputJson),
      stringify(trace.outputJson),
    ]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join('\n')
      .toLowerCase();
    searchTextCache.set(trace, text);
  }
  return text;
}

export function filterTraces(
  traces: readonly AgentTraceRecord[],
  filter: TraceFilter
): AgentTraceRecord[] {
  if (!isTraceFilterActive(filter)) {
    return traces as AgentTraceRecord[];
  }
  const query = filter.query.trim().toLowerCase();
  return traces.filter(
    (t) =>
      (filter.kind === 'all' || t.type === filter.kind) &&
      (!filter.errorsOnly || Boolean(t.error)) &&
      (query === '' || traceSearchText(t).includes(query))
  );
}

/**
 * The newest `limit` traces. The stream is read from the bottom while a run is live, so the
 * oldest are the ones held back.
 */
export function newestTraces(
  traces: readonly AgentTraceRecord[],
  limit: number
): { shown: AgentTraceRecord[]; hidden: number } {
  if (traces.length <= limit) {
    return { hidden: 0, shown: traces as AgentTraceRecord[] };
  }
  return { hidden: traces.length - limit, shown: traces.slice(traces.length - limit) };
}

/**
 * When a trace happened, as time since the run started: `+02:14`, or `+1:02:14` past an hour.
 * Null when either time is missing or unreadable. A trace stamped before the start (clock skew)
 * reads `+00:00` rather than a negative time.
 */
export function formatTraceOffset(
  createdAt: string | null | undefined,
  startedAt: string | null | undefined
): string | null {
  if (!createdAt || !startedAt) {
    return null;
  }
  const delta = Date.parse(createdAt) - Date.parse(startedAt);
  if (!Number.isFinite(delta)) {
    return null;
  }
  const total = Math.max(0, Math.floor(delta / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `+${h}:${pad(m)}:${pad(s)}` : `+${pad(m)}:${pad(s)}`;
}
