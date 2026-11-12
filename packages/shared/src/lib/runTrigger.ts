/**
 * What started a run, recorded once at creation as `WorkflowRun.trigger`. Provenance only: it is
 * not a credential key (that stays `launchedById`) and a run's behaviour never reads it.
 */
export const RUN_TRIGGERS = [
  'work-request',
  'work-request-retry',
  'template-run',
  'template-retry',
  'agent-run',
  'service-token',
  'slack',
  'webhook',
  'automation',
  'schedule',
  'prd-run',
  'prd-child',
  'epic',
  'epic-child',
  'code-review',
  'channel-task',
  'channel-turn',
  'review-fix',
  'unknown',
] as const;

export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export function isRunTrigger(value: unknown): value is RunTrigger {
  return typeof value === 'string' && (RUN_TRIGGERS as readonly string[]).includes(value);
}
