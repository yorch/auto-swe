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

/**
 * The `RunInput.externalTicketId` a channel-launched task run is filed under.
 *
 * Shared for the same reason as the workflow id above, and used for the same
 * kind of lookup from the other direction: the worker writes the row, and the
 * gateway finds it — on the indexed column — to learn which repository a thread's
 * task targets. Note the parts: the Slack channel id (`C…`), not our
 * `SlackChannel.id`, which is what the workflow id uses.
 */
export function channelTaskExternalTicketId(slackChannelId: string, threadTs: string): string {
  return `slack-${slackChannelId}-${threadTs}`;
}

/** The Temporal signal name a channel task run accepts for mid-flight steering. */
export const CHANNEL_TASK_STEER_SIGNAL = 'steer';

/**
 * Names of the seeded GLOBAL channel templates. Single source of truth (this
 * module is pure + isolate-safe + already aliased for vitest), imported by the
 * seed (`syncBuiltins`), the worker activities that look the rows up by name
 * (`channelTask`, `channelRun`), and the gateway `/runs` exclusion — so the seed
 * name and every lookup/filter can't drift apart.
 */
export const CHANNEL_ASSISTANT_TEMPLATE_NAME = 'Channel Assistant';
export const CHANNEL_TASK_TEMPLATE_NAME = 'Channel Task';
