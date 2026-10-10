import { persistActivityTrace } from './activityContext.js';
import { AgentTracer } from './agentTracer.js';

/**
 * Record a memory-gate event (`MEMORY_SECURITY_EVENTS`) from code that holds no
 * tracer of its own — a recall deep inside a reader, a channel summary written
 * after the turn's trace is assembled. It writes one `activity_event` row for
 * the current activity, so the security-events feed lists it beside the events
 * a tracer-holding caller records.
 *
 * Best-effort, and never throws: the gate has already done its job, and the
 * record of it must not fail the caller. A write that fails is logged. Outside
 * a Temporal activity there is no run to attach a row to, so the event is only
 * logged.
 */
export async function recordMemorySecurityEvent(
  name: string,
  outputJson: Record<string, unknown>
): Promise<void> {
  try {
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name, outputJson });
    const written = await persistActivityTrace(tracer, 'memoryGuard');
    if (written === false) {
      console.warn(`[memoryGuard] ${name} not recorded: the write failed`);
    }
  } catch (err) {
    console.warn(
      `[memoryGuard] ${name} not recorded: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** How long one dropped item is reported once, per process. */
export const RECALL_DROP_REPORT_TTL_MS = 60 * 60 * 1000;
/** Ids remembered at most; the oldest is forgotten first. */
const RECALL_DROP_REPORT_MAX = 1_000;

/** Memory id → when this process last reported dropping it. Insertion order is age order. */
const lastReported = new Map<string, number>();

/**
 * The ids among `ids` not reported in the last {@link RECALL_DROP_REPORT_TTL_MS},
 * marking them reported now. A flagged row that stays in the table is dropped
 * on every recall that reaches it; one event per id per hour says the same
 * thing without flooding the feed. Per process, so gateway and each worker
 * report independently, and a restart reports again.
 */
export function unreportedRecallDrops(ids: ReadonlyArray<string>, now = Date.now()): string[] {
  const fresh: string[] = [];
  for (const id of ids) {
    const at = lastReported.get(id);
    if (at !== undefined && now - at < RECALL_DROP_REPORT_TTL_MS) {
      continue;
    }
    lastReported.delete(id);
    lastReported.set(id, now);
    fresh.push(id);
  }
  while (lastReported.size > RECALL_DROP_REPORT_MAX) {
    const oldest = lastReported.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    lastReported.delete(oldest);
  }
  return fresh;
}

/** Test seam: forget every reported drop. */
export function _resetRecallDropReportsForTests(): void {
  lastReported.clear();
}
