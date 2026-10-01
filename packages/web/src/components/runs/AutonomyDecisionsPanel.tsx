'use client';

import type { AutonomyDecisionDto } from '@auto-swe/shared/types/api';
import { Alert } from '@/components/ui/Alert';
import { useAutonomyDecisionsForRun } from '@/hooks/useRuns';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';

function DecisionRow({ row }: { row: AutonomyDecisionDto }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-ink-600/40 last:border-0">
      <span
        className="text-paper-400 truncate"
        style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}
        title={`${row.event}${row.riskClass ? ` — ${row.riskClass}` : ''}`}
      >
        {row.event}
        {row.riskClass ? ` · ${row.riskClass}` : null}
      </span>
      <span
        className="text-paper-500 shrink-0"
        style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}
      >
        {formatDate(row.createdAt)}
      </span>
    </div>
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
      <>
        <div className="h-px mx-5 bg-ink-500/40" />
        <div className="px-5 py-4">
          <div className="kicker mb-2">Autonomy decisions</div>
          <Alert className="text-xs" variant="error">
            Could not load autonomy decisions: {errMsg(error, 'request failed')}
          </Alert>
        </div>
      </>
    );
  }

  if (isLoading || !data || data.length === 0) {
    return null;
  }

  return (
    <>
      <div className="h-px mx-5 bg-ink-500/40" />
      <div className="px-5 py-4">
        <div className="kicker mb-2">Autonomy decisions</div>
        <div>
          {data.map((row) => (
            <DecisionRow key={row.id} row={row} />
          ))}
        </div>
      </div>
    </>
  );
}
