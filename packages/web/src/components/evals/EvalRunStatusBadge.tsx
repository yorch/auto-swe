import { Badge, type BadgeTone } from '@/components/ui/Badge';

const TONE: Record<string, BadgeTone> = {
  FAILED: 'brick',
  REGRESSION: 'brick',
  RUNNING: 'amber',
  SUCCESS: 'moss',
};

/** An offline harness run's status: RUNNING | SUCCESS | FAILED | REGRESSION. */
export function EvalRunStatusBadge({ status }: { status: string }) {
  return (
    <Badge dot={status === 'RUNNING' ? 'pulse' : false} tone={TONE[status] ?? 'dust'} uppercase>
      {status}
    </Badge>
  );
}
