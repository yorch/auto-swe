import { Badge, type BadgeTone } from '@/components/ui/Badge';

const TONE: Record<string, BadgeTone> = {
  FAILED: 'brick',
  REGRESSION: 'brick',
  RUNNING: 'amber',
  SUCCESS: 'moss',
};

const LABEL: Record<string, string> = {
  FAILED: 'Did not finish',
  REGRESSION: 'Regression',
  RUNNING: 'Running',
  SUCCESS: 'Passed',
};

/** What each status means, for the tooltip. */
const MEANING: Record<string, string> = {
  FAILED: 'The run stopped before it reached a verdict, so nothing was compared.',
  REGRESSION: 'The candidate scored significantly worse than the baseline.',
  RUNNING: 'The benchmark is still running; there is no verdict yet.',
  SUCCESS: 'The candidate did not score significantly worse than the baseline.',
};

/**
 * An offline harness run's status: RUNNING | SUCCESS | FAILED | REGRESSION, shown in
 * plain words with the meaning on hover. A `partial` verdict covers only the cases the
 * runless budget or the organization cap (`reason: 'org_budget'`) let run, so it is
 * labelled as such and drawn amber rather than as a plain pass.
 */
export function EvalRunStatusBadge({ status, partial }: { status: string; partial?: boolean }) {
  const isPartial = partial === true && (status === 'SUCCESS' || status === 'REGRESSION');
  const label = LABEL[status] ?? status;
  const meaning = MEANING[status] ?? 'An unrecognised status.';
  return (
    <span
      title={
        isPartial ? `${meaning} Only some of the cases ran: a budget stopped the rest.` : meaning
      }
    >
      <Badge
        dot={status === 'RUNNING' ? 'pulse' : false}
        tone={isPartial ? 'amber' : (TONE[status] ?? 'dust')}
      >
        {isPartial ? `${label} (partial)` : label}
      </Badge>
    </span>
  );
}
