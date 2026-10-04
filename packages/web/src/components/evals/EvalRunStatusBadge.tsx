import { Badge, type BadgeTone } from '@/components/ui/Badge';

const TONE: Record<string, BadgeTone> = {
  FAILED: 'brick',
  REGRESSION: 'brick',
  RUNNING: 'amber',
  SUCCESS: 'moss',
};

/**
 * An offline harness run's status: RUNNING | SUCCESS | FAILED | REGRESSION. A
 * `partial` verdict covers only the cases the runless budget or the organization cap
 * (`reason: 'org_budget'`) let run, so it is
 * labelled as such and drawn amber rather than as a plain pass.
 */
export function EvalRunStatusBadge({ status, partial }: { status: string; partial?: boolean }) {
  const isPartial = partial === true && (status === 'SUCCESS' || status === 'REGRESSION');
  return (
    <Badge
      dot={status === 'RUNNING' ? 'pulse' : false}
      tone={isPartial ? 'amber' : (TONE[status] ?? 'dust')}
      uppercase
    >
      {isPartial ? `${status} (partial)` : status}
    </Badge>
  );
}
