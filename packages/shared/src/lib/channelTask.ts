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

/**
 * True for the platform-started Channel Assistant: a GLOBAL template (no team) of that
 * name. It is listed but never launched or edited by hand — the UI hides Run/Edit and
 * the run route refuses it.
 */
export function isSystemManagedTemplate(t: { name: string; team: unknown | null }): boolean {
  return t.team === null && t.name === CHANNEL_ASSISTANT_TEMPLATE_NAME;
}

/**
 * Minimal valid `WorkflowSpec` for the Channel Assistant template: a single
 * terminal node. The `/runs` trace viewer renders the AgentTrace event stream
 * regardless of node mapping, so a richer graph would be dead weight here.
 *
 * Typed loosely (object literal) so this file doesn't depend on the workflow spec
 * package; it is parsed/validated wherever it's consumed.
 */
export const CHANNEL_ASSISTANT_SPEC = {
  description:
    "Records channel-assistant conversations so they appear in run history. Runs automatically; it can't be launched by hand.",
  entry: 'done',
  name: CHANNEL_ASSISTANT_TEMPLATE_NAME,
  nodes: {
    done: { status: 'SUCCESS', type: 'terminate' },
  },
  schemaVersion: 1,
} as const;
