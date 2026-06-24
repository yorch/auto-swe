/**
 * Deterministic Temporal workflow id for a channel-launched task run.
 *
 * One task run per Slack thread: `chantask-<channelId>-<threadTs>`, with each
 * part sanitized to the Temporal-safe `[A-Za-z0-9_-]` charset. Shared so the
 * worker (which starts the run) and the gateway (which signals it on a thread
 * reply — `steer`) reconstruct the EXACT same id without a DB lookup.
 */
export function channelTaskWorkflowId(channelId: string, threadTs: string): string {
  return `chantask-${sanitizeIdPart(channelId)}-${sanitizeIdPart(threadTs)}`;
}

function sanitizeIdPart(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, '-');
}

/** The Temporal signal name a channel task run accepts for mid-flight steering. */
export const CHANNEL_TASK_STEER_SIGNAL = 'steer';
