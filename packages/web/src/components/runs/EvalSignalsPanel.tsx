'use client';

import type { EvalResultDto } from '@auto-swe/shared/types/api';
import { Alert } from '@/components/ui/Alert';
import { useEvalResultsForRun } from '@/hooks/useRuns';
import { errMsg } from '@/lib/errors';
import { scoreColor } from '@/lib/utils';
import { RailRow, RailSection } from './Rail';

function SignalRow({ row }: { row: EvalResultDto }) {
  return (
    <RailRow>
      <span className="truncate font-mono text-[11px] text-paper-400" title={row.scorer}>
        {row.scorer}
      </span>
      <span className="num shrink-0 text-[11px]" style={{ color: scoreColor(row.value) }}>
        {row.scoreType === 'BOOLEAN' && typeof row.value === 'number'
          ? row.value >= 1
            ? 'pass'
            : 'fail'
          : typeof row.value === 'number'
            ? row.value.toFixed(2)
            : String(row.value ?? '—')}
      </span>
    </RailRow>
  );
}

/**
 * P0 evals: a thin, read-only panel of captured quality signals (gate / review
 * verdict / merge) for a run. The first consumer of the EvalResult capture
 * layer; trend dashboards arrive in P3.
 */
export function EvalSignalsPanel({ runId }: { runId: string }) {
  const { data, error, isError, isLoading } = useEvalResultsForRun(runId);

  if (isError) {
    return (
      <RailSection title="Eval signals">
        <Alert className="text-xs" variant="error">
          Could not load eval signals: {errMsg(error, 'request failed')}
        </Alert>
      </RailSection>
    );
  }

  if (isLoading || !data || data.length === 0) {
    return null;
  }

  return (
    <RailSection title="Eval signals">
      {data.map((row) => (
        <SignalRow key={row.id} row={row} />
      ))}
    </RailSection>
  );
}
