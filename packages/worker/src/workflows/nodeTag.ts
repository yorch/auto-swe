/**
 * Which workflow-spec node an activity is running for.
 *
 * The interpreter knows it at dispatch time; the activity needs it when it
 * persists its traces. The workflow stamps it on the scheduled activity as a
 * Temporal header (`nodeTagInterceptor.ts`) and the worker reads it back before
 * the activity body runs (`lib/activityNodeTag.ts`). This file is the contract
 * between the two and holds nothing that needs a runtime, so both the workflow
 * isolate and the activity process can import it.
 */
export const NODE_TAG_HEADER = 'x-auto-swe-node';

export interface NodeTag {
  /** Key in `spec.nodes`. */
  specNodeId: string;
  /** Interpreter recording id: the key, branch-prefixed inside a fan-out (`fan[0]/impl`). */
  recordingId: string;
  /** Interpreter attempt at this node (1-based); `onFail.retry` dispatches again. */
  stepAttempt: number;
}

/** Narrow an untrusted decoded header value; anything malformed means "no tag". */
export function parseNodeTag(value: unknown): NodeTag | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.specNodeId !== 'string' ||
    typeof v.recordingId !== 'string' ||
    typeof v.stepAttempt !== 'number'
  ) {
    return undefined;
  }
  return { recordingId: v.recordingId, specNodeId: v.specNodeId, stepAttempt: v.stepAttempt };
}
