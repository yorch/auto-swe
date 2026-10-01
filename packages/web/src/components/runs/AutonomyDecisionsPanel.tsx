'use client';

import type { AutonomyDecisionDto } from '@auto-swe/shared/types/api';
import { Alert } from '@/components/ui/Alert';
import { useAutonomyDecisionsForRun } from '@/hooks/useRuns';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';
import { RailRow, RailSection } from './Rail';

function DecisionRow({ row }: { row: AutonomyDecisionDto }) {
  return (
    <RailRow>
      <span
        className="truncate font-mono text-[11px] text-paper-400"
        title={`${row.event}${row.riskClass ? ` — ${row.riskClass}` : ''}`}
      >
        {row.event}
        {row.riskClass ? ` · ${row.riskClass}` : null}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-paper-500">
        {formatDate(row.createdAt)}
      </span>
    </RailRow>
  );
}

/**
 * P3 governance: a read-only panel of autonomy decisions and human approvals
 * for a run. Shows the publish/approval path that the `AutonomyDecision` audit
 * table captures.
 */
export function AutonomyDecisionsPanel({ runId }: { runId: string }) {
  const { data, error, isError, isLoading } = useAutonomyDecisionsForRun(runId);

  if (isError) {
    return (
      <RailSection title="Autonomy decisions">
        <Alert className="text-xs" variant="error">
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
