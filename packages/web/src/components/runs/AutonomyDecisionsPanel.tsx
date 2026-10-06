'use client';

import type { AutonomyDecisionDto } from '@auto-swe/shared/types/api';
import { Alert } from '@/components/ui/Alert';
import { useAutonomyDecisionsForRun } from '@/hooks/useRuns';
import { errMsg } from '@/lib/errors';
import { cn, formatDate } from '@/lib/utils';
import { RAIL_CODE, RailRow, RailSection } from './Rail';

function DecisionRow({ row }: { row: AutonomyDecisionDto }) {
  return (
    <RailRow>
      <span
        className={cn(RAIL_CODE, 'truncate')}
        title={`${row.event}${row.riskClass ? ` — ${row.riskClass}` : ''}`}
      >
        {row.event}
        {row.riskClass ? <span className="text-paper-500"> · {row.riskClass}</span> : null}
      </span>
      <span className="tabular shrink-0 text-xs text-paper-500">{formatDate(row.createdAt)}</span>
    </RailRow>
  );
}

/**
 * A read-only panel of autonomy decisions and human approvals for a run: the
 * publish/approval path that the `AutonomyDecision` audit table captures.
 */
export function AutonomyDecisionsPanel({ runId }: { runId: string }) {
  const { data, error, isError, isLoading } = useAutonomyDecisionsForRun(runId);

  if (isError) {
    return (
      <RailSection title="Autonomy decisions">
        <Alert className="text-[13px]" variant="error">
          Could not load autonomy decisions: {errMsg(error, 'request failed')}
        </Alert>
      </RailSection>
    );
  }

  if (isLoading || !data || data.length === 0) {
    return null;
  }

  return (
    <RailSection title="Autonomy decisions">
      {data.map((row) => (
        <DecisionRow key={row.id} row={row} />
      ))}
    </RailSection>
  );
}
