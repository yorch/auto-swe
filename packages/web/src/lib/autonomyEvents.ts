import { KNOWN_RISK_CLASSES } from '@auto-swe/shared/lib/autonomyPolicy';

/**
 * Plain-language names for the events an autonomy decision records. Approval step
 * actions are configured per step, so a decision can carry one this list does not
 * know; `eventLabel` then shows it as written.
 */
const EVENT_LABELS: Record<string, string> = {
  approve: 'Approved',
  approve_partial: 'Approved (more approvals needed)',
  publish: 'Published',
  reject: 'Rejected',
};

export const KNOWN_AUTONOMY_EVENTS = Object.keys(EVENT_LABELS);

export function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event;
}

const RISK_CLASS_LABELS: Record<string, string> = Object.fromEntries(
  KNOWN_RISK_CLASSES.map((c) => [c.key, c.label])
);

/** A risk class's plain-language name; a custom class an older policy carries keeps its own text. */
export function riskClassLabel(key: string): string {
  return RISK_CLASS_LABELS[key] ?? key;
}
