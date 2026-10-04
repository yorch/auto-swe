import {
  type Context,
  context,
  type Link,
  propagation,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';
import {
  defaultPayloadConverter,
  type Payload,
  type WorkflowClientInterceptor,
} from '@temporalio/client';

/**
 * Carries the W3C trace context of whoever started a workflow — a gateway
 * request, or an activity launching a run — to every activity that workflow
 * schedules, so all of them land in that caller's trace.
 *
 * Three hops, none of which loads OpenTelemetry into the workflow isolate:
 * this client interceptor writes the header; the worker's workflow interceptor
 * (`workflows/traceContextInterceptor.ts`, which repeats this name because the
 * isolate cannot import this module) copies it, untouched, onto each scheduled
 * activity and child workflow; the worker's activity interceptor reads it back
 * with {@link traceContextFromHeaders} and parents the activity span on it.
 */
export const TRACE_CONTEXT_HEADER = 'x-auto-swe-trace';

/**
 * The context of the most recent signal or update a workflow received,
 * forwarded onto the activities it schedules afterwards. The activity span
 * links to it rather than parenting on it.
 */
export const TRACE_SIGNAL_HEADER = 'x-auto-swe-trace-signal';

/** The active context as a W3C carrier (`traceparent`, `tracestate`), or undefined when there is none. */
function activeCarrier(): Record<string, string> | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ? carrier : undefined;
}

function withTraceHeader<T extends { headers: Record<string, Payload> }>(input: T): T {
  const carrier = activeCarrier();
  if (!carrier) {
    return input;
  }
  return {
    ...input,
    headers: {
      ...input.headers,
      [TRACE_CONTEXT_HEADER]: defaultPayloadConverter.toPayload(carrier),
    },
  };
}

/**
 * Client interceptor: stamp the caller's trace context on every workflow it
 * starts, and on every signal and update it sends to a running one.
 */
export function traceContextClientInterceptor(): WorkflowClientInterceptor {
  return {
    signal: (input, next) => next(withTraceHeader(input)),
    signalWithStart: (input, next) => next(withTraceHeader(input)),
    startUpdate: (input, next) => next(withTraceHeader(input)),
    startWithDetails: (input, next) => next(withTraceHeader(input)),
  };
}

/**
 * The context to parent an activity span on: the starter's, when the header is
 * present and decodes; otherwise the root context, i.e. a new trace.
 */
export function traceContextFromHeaders(
  headers: Record<string, Payload> | undefined,
  name: string = TRACE_CONTEXT_HEADER
): Context {
  const raw = headers?.[name];
  if (!raw) {
    return ROOT_CONTEXT;
  }
  try {
    const carrier = defaultPayloadConverter.fromPayload<Record<string, string>>(raw);
    return propagation.extract(ROOT_CONTEXT, carrier);
  } catch {
    // A header this process cannot decode only costs the link, never the activity.
    return ROOT_CONTEXT;
  }
}

/** A span link to the signal that most recently reached the workflow, when the header is present and decodes. */
export function signalLinkFromHeaders(
  headers: Record<string, Payload> | undefined
): Link | undefined {
  const spanContext = trace.getSpanContext(traceContextFromHeaders(headers, TRACE_SIGNAL_HEADER));
  return spanContext ? { context: spanContext } : undefined;
}
