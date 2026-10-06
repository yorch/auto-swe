'use client';

import type { EvalResultDto } from '@auto-swe/shared/types/api';
import { Alert } from '@/components/ui/Alert';
import { useEvalResultsForRun } from '@/hooks/useRuns';
import { errMsg } from '@/lib/errors';
import { cn, scoreColor } from '@/lib/utils';
import { RAIL_CODE, RailRow, RailSection } from './Rail';

function SignalRow({ row }: { row: EvalResultDto }) {
  return (
    <RailRow>
      <span className={cn(RAIL_CODE, 'truncate')} title={row.scorer}>
        {row.scorer}
      </span>
      <span
        className="tabular shrink-0 text-[13px] font-medium"
        style={{ color: scoreColor(row.value) }}
      >
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
 * A thin, read-only panel of captured quality signals (gate / review verdict /
 * merge) for a run, read from the EvalResult capture layer.
 */
export function EvalSignalsPanel({ runId }: { runId: string }) {
  const { data, error, isError, isLoading } = useEvalResultsForRun(runId);

  if (isError) {
    return (
      <RailSection title="Eval signals">
        <Alert className="text-[13px]" variant="error">
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
