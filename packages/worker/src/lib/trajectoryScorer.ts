/**
 * Trajectory scorer — P1 of the evals feature (docs/evals-p1.md).
 *
 * Programmatic (no-LLM-cost) metrics over the `AgentTrace` rows a run already
 * produces: how the agent got there, not just the end-state. The RFC (§2, §9)
 * is explicit that this axis is **advisory until baselined** — per-repo
 * baselines + metric weights still need tuning — so it emits raw metrics and a
 * normalized-but-advisory score; it does NOT gate.
 *
 * Pure function over trace-like records; unit-tested directly.
 */

import { isSecurityBlockTraceError } from '@auto-swe/shared/lib/scannerCache';

/** The subset of an AgentTrace row this scorer reads. */
export interface TraceLike {
  /** "tool_call" | "llm_response" | "activity_event". */
  type: string;
  toolName?: string | null;
  error?: string | null;
}

export interface TrajectoryMetrics {
  /** Total tool calls (proxy for effort/steps). */
  stepCount: number;
  /** Tool calls that ended in an error. */
  toolErrors: number;
  /** Non-erroring tool-call ratio in [0,1] (1 when there were no tool calls). */
  toolCorrectness: number;
  /** Tool calls blocked by a security scanner (guardrail respect). */
  guardrailHits: number;
}

/**
 * A tool call counts as a guardrail hit when its `AgentTrace.error` carries one
 * of the block tags the implementer's tools write (`SECURITY_TRACE_ERRORS` in
 * shared) — the same strings the security-events endpoint filters on. Used only
 * to *count* guardrail events here; the scanners themselves do the blocking.
 */
function isGuardrailHit(error: string | null | undefined): boolean {
  return isSecurityBlockTraceError(error);
}

export function scoreTrajectory(traces: TraceLike[]): TrajectoryMetrics {
  let stepCount = 0;
  let toolErrors = 0;
  let guardrailHits = 0;
  for (const t of traces) {
    if (t.type !== 'tool_call') {
      continue;
    }
    stepCount += 1;
    if (t.error) {
      toolErrors += 1;
    }
    if (isGuardrailHit(t.error)) {
      guardrailHits += 1;
    }
  }
  const toolCorrectness = stepCount === 0 ? 1 : (stepCount - toolErrors) / stepCount;
  return { guardrailHits, stepCount, toolCorrectness, toolErrors };
}
