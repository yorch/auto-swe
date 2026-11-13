import type { RunTrigger } from '@auto-swe/shared/lib/runTrigger';
import type { WorkflowRunSummary } from '@auto-swe/shared/types/api';

/** Human wording for what started a run. Exhaustive: a new trigger fails typecheck until named. */
export const RUN_TRIGGER_LABELS: Record<RunTrigger, string> = {
  'agent-run': 'Agent run',
  automation: 'Automation',
  'channel-task': 'Channel task',
  'channel-turn': 'Channel turn',
  'code-review': 'Code review',
  epic: 'Epic',
  'epic-child': 'Epic repo run',
  'prd-child': 'PRD story',
  'prd-run': 'PRD run',
  'review-fix': 'Review fix',
  schedule: 'Schedule',
  'service-token': 'API token',
  slack: 'Slack',
  'template-retry': 'Re-run',
  'template-run': 'Template run',
  unknown: 'Unknown',
  webhook: 'Webhook',
  'work-request': 'Work request',
  'work-request-retry': 'Re-run',
};

export type RunInitiatorKind = 'person' | 'service' | 'system' | 'unknown';

export interface RunInitiator {
  primary: string;
  secondary?: string;
  kind: RunInitiatorKind;
  /** Hover text. For a person it joins the cleaned name and email; for a system run it explains. */
  title?: string;
}

type RunProvenance = Partial<
  Pick<WorkflowRunSummary, 'trigger' | 'initiatedBy' | 'initiatedByService'>
>;

export const SERVICE_PRINCIPAL_LABEL = 'Service principal';
export const NOT_RECORDED_LABEL = 'Not recorded';

const NOT_RECORDED_TITLE =
  "Runs started before initiators were tracked don't record who started them.";
const SCHEDULE_TITLE =
  'Started by the schedule. A manual \u201cRun now\u201d is not attributed to a person.';
const NO_PERSON_TITLE = 'No person is recorded for this run.';

/** Control and format characters (which include bidi overrides) never reach the page. */
function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
}

/**
 * Who or what started a run. A person is named (with their email as the second line when a name
 * exists); a service principal by its name; a run with neither shows only the trigger kind.
 * `triggerRefId` is an opaque id and is deliberately never shown.
 */
export function describeRunInitiator(run: RunProvenance): RunInitiator {
  const person = run.initiatedBy;
  if (person) {
    const email = clean(person.email);
    const name = clean(person.name);
    return name
      ? { kind: 'person', primary: name, secondary: email, title: `${name} <${email}>` }
      : { kind: 'person', primary: email, title: email };
  }
  if (run.initiatedByService) {
    const name = clean(run.initiatedByService.name) || 'Unnamed service';
    return { kind: 'service', primary: name, secondary: SERVICE_PRINCIPAL_LABEL, title: name };
  }
  if (run.trigger) {
    return {
      kind: 'system',
      primary: RUN_TRIGGER_LABELS[run.trigger],
      title: run.trigger === 'schedule' ? SCHEDULE_TITLE : NO_PERSON_TITLE,
    };
  }
  return { kind: 'unknown', primary: NOT_RECORDED_LABEL, title: NOT_RECORDED_TITLE };
}
