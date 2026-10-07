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
 * record of it must not fail the caller. Outside a Temporal activity there is
 * no run to attach a row to, so the event is only logged.
 */
export async function recordMemorySecurityEvent(
  name: string,
  outputJson: Record<string, unknown>
): Promise<void> {
  try {
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name, outputJson });
    await persistActivityTrace(tracer, 'memoryGuard');
  } catch (err) {
    console.warn(
      `[memoryGuard] ${name} not recorded as a security event: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
