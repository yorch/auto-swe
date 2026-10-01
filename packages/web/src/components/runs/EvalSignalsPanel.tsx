'use client';

import type { EvalResultDto } from '@auto-swe/shared/types/api';
import { Alert } from '@/components/ui/Alert';
import { useEvalResultsForRun } from '@/hooks/useRuns';
import { errMsg } from '@/lib/errors';
import { scoreColor } from '@/lib/utils';

function SignalRow({ row }: { row: EvalResultDto }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-ink-600/40 last:border-0">
      <span
        className="text-paper-400 truncate"
        style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}
        title={row.scorer}
      >
        {row.scorer}
      </span>
      <span
        className="num shrink-0"
        style={{
          color: scoreColor(row.value),
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
        }}
      >
        {row.scoreType === 'BOOLEAN' && typeof row.value === 'number'
          ? row.value >= 1
            ? 'pass'
            : 'fail'
          : typeof row.value === 'number'
            ? row.value.toFixed(2)
            : String(row.value ?? '—')}
      </span>
    </div>
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
      <>
        <div className="h-px mx-5 bg-ink-500/40" />
        <div className="px-5 py-4">
          <div className="kicker mb-2">Eval signals</div>
          <Alert className="text-xs" variant="error">
            Could not load eval signals: {errMsg(error, 'request failed')}
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
        <div className="kicker mb-2">Eval signals</div>
        <div>
          {data.map((row) => (
            <SignalRow key={row.id} row={row} />
          ))}
        </div>
      </div>
    </>
  );
}
