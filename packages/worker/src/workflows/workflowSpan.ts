/**
 * Pure helpers for the workflow span, shared by the workflow interceptor (which
 * runs in the Temporal V8 isolate) and the worker-side sink that exports it.
 * No runtime imports: OpenTelemetry must not load in the isolate, and the span
 * ids here are plain arithmetic so they are identical on every replay.
 */

/** 128 bits from a string, as 32 hex digits — four independently seeded 32-bit mixes (cyrb128). */
export function hash128(text: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1, h2, h3, h4].map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
}

const ZERO_SPAN_ID = '0000000000000000';

/** The trace id of a run nobody gave a trace context: a hash of the run chain's identity. */
export function derivedTraceId(workflowId: string, firstExecutionRunId: string): string {
  return hash128(`${workflowId}/${firstExecutionRunId}`);
}

/**
 * The id of a run's workflow span: 16 hex digits hashed from the workflow id and
 * the run id, so each run of a continue-as-new chain gets its own span. Never the
 * all-zero id, which W3C Trace Context treats as invalid.
 */
export function workflowSpanId(workflowId: string, runId: string): string {
  const id = hash128(`workflow-span/${workflowId}/${runId}`).slice(0, 16);
  return id === ZERO_SPAN_ID ? '0000000000000001' : id;
}

export interface TraceParent {
  traceId: string;
  spanId: string;
  flags: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A W3C `traceparent` split into its parts, or undefined when it is malformed or names an all-zero id. */
export function parseTraceparent(value: unknown): TraceParent | undefined {
  const m = typeof value === 'string' ? TRACEPARENT.exec(value) : null;
  if (!m) {
    return undefined;
  }
  const [, traceId, spanId, flags] = m as unknown as [string, string, string, string];
  if (/^0+$/.test(traceId) || spanId === ZERO_SPAN_ID) {
    return undefined;
  }
  return { flags, spanId, traceId };
}

export interface WorkflowSpanContext {
  /** The carrier handed to activities, local activities, children and the continuation. */
  carrier: Record<string, string>;
  /** The starter's span; absent when the run has no starter, which makes the workflow span the root. */
  parentSpanId?: string;
  spanId: string;
  traceId: string;
  /** W3C trace flags, two hex digits. */
  flags: string;
  traceState?: string;
}

/**
 * Where a run sits in a trace, given the carrier it was started with (or none).
 * The returned carrier is the starter's with its parent span id replaced by the
 * workflow span, so the hierarchy is starter → workflow → activity. A run with
 * no usable carrier gets a derived trace and the workflow span is its root; the
 * flag is `01` (sampled) so a parent-based sampler keeps a schedule-started run.
 */
export function workflowSpanContext(
  incoming: Record<string, string> | undefined,
  workflowId: string,
  runId: string,
  firstExecutionRunId: string
): WorkflowSpanContext {
  const parent = parseTraceparent(incoming?.traceparent);
  const spanId = workflowSpanId(workflowId, runId);
  const traceId = parent?.traceId ?? derivedTraceId(workflowId, firstExecutionRunId);
  const flags = parent?.flags ?? '01';
  const traceState = parent ? incoming?.tracestate || undefined : undefined;
  const carrier: Record<string, string> = { traceparent: `00-${traceId}-${spanId}-${flags}` };
  if (traceState) {
    carrier.tracestate = traceState;
  }
  return {
    carrier,
    flags,
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    spanId,
    ...(traceState ? { traceState } : {}),
    traceId,
  };
}

/** What a run's workflow code observed when it ended. */
export type WorkflowSpanOutcome = 'completed' | 'failed' | 'cancelled' | 'continued-as-new';

/** The argument of the `workflowSpans.exportSpan` sink; plain data, so it crosses the isolate boundary. */
export interface WorkflowSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  flags: string;
  startTimeMs: number;
  endTimeMs: number;
  outcome: WorkflowSpanOutcome;
  errorMessage?: string;
}

/** Declares the sink for `proxySinks`; the worker implements it in `lib/workflowSpanSink.ts`. */
// A type alias, not an interface: `proxySinks` constrains to an index signature.
export type WorkflowSpanSinks = {
  workflowSpans: {
    exportSpan(record: WorkflowSpanRecord): void;
  };
};
