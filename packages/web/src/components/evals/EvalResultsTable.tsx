'use client';

import {
  EVAL_SIGNAL_SOURCES,
  type EvalResultDto,
  type EvalSignalSourceValue,
} from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Toolbar } from '@/components/ui/Toolbar';
import { useEvalResults } from '@/hooks/useAdmin';
import { resultRuntimes, runtimeLabel } from '@/lib/evalRuntime';
import { formatDate, formatRelativeTime, scoreColor } from '@/lib/utils';

const LIMIT = 25;

const SOURCE_OPTIONS = [
  { label: 'All sources', value: '' },
  ...EVAL_SIGNAL_SOURCES.map((s) => ({ label: s, value: s })),
];

export function formatScore(row: Pick<EvalResultDto, 'scoreType' | 'value'>): string {
  if (row.scoreType === 'BOOLEAN') {
    return row.value >= 1 ? 'pass' : 'fail';
  }
  return row.value.toFixed(2);
}

/** The candidate arm's runtime, and the baseline's when the pair ran on different ones. */
function ResultRuntime({ row }: { row: EvalResultDto }) {
  const { baseline, candidate } = resultRuntimes(row);
  if (!candidate) {
    return <span className="text-paper-600">—</span>;
  }
  return (
    <span>
      {runtimeLabel(candidate)}
      {baseline && baseline !== candidate && (
        <span className="text-paper-500"> vs {runtimeLabel(baseline)}</span>
      )}
    </span>
  );
}

/** Where a result came from: the workflow run it scored, or the harness run and case. */
function ResultOrigin({ row, showEvalRun }: { row: EvalResultDto; showEvalRun: boolean }) {
  if (row.runId) {
    return (
      <Link
        className="font-mono text-paper-100 underline-offset-2 hover:underline focus-visible:underline"
        href={`/runs/${row.runId}`}
        title={row.runId}
      >
        run {row.runId.slice(0, 8)}
      </Link>
    );
  }
  if (row.evalRunId && showEvalRun) {
    return (
      <Link
        className="font-mono text-paper-100 underline-offset-2 hover:underline focus-visible:underline"
        href={`/admin/evals/runs/${row.evalRunId}`}
        title={row.evalRunId}
      >
        eval run {row.evalRunId.slice(0, 8)}
      </Link>
    );
  }
  if (row.caseId) {
    return (
      <span className="font-mono" title={row.caseId}>
        case {row.caseId.slice(0, 8)}
      </span>
    );
  }
  return <span className="text-paper-600">—</span>;
}

/**
 * Paginated eval results, newest first, filterable by scorer and source. Each
 * row links to the run it scored when it has one. `evalRunId` pins the table to
 * one harness run.
 */
export function EvalResultsTable({
  evalRunId,
  scorers,
  scorer,
  onScorerChange,
}: {
  evalRunId?: string;
  /** Scorers offered in the filter, beyond those on the page shown. */
  scorers: string[];
  /** Controlled scorer filter; '' for all. */
  scorer: string;
  onScorerChange: (scorer: string) => void;
}) {
  const [source, setSource] = useState<EvalSignalSourceValue | ''>('');
  const [offset, setOffset] = useState(0);
  const [prevScorer, setPrevScorer] = useState(scorer);
  // A scorer change from outside (the trend card) starts again from page one.
  if (prevScorer !== scorer) {
    setPrevScorer(scorer);
    setOffset(0);
  }
  const { data, error, isError, isFetching, refetch, isLoading } = useEvalResults({
    evalRunId,
    limit: LIMIT,
    offset,
    scorer: scorer || undefined,
    source: source || undefined,
  });
  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  // The offered scorers, plus any on this page and the one selected.
  const scorerOptions = [
    ...new Set([...scorers, ...rows.map((r) => r.scorer), ...(scorer ? [scorer] : [])]),
  ].sort();

  return (
    <div className="space-y-3">
      <Toolbar
        end={
          total > 0 ? (
            <span className="text-xs text-paper-500 tabular-nums">
              {total} result{total === 1 ? '' : 's'}
            </span>
          ) : undefined
        }
      >
        <Select
          appearance="pill"
          aria-label="Filter by scorer"
          onChange={onScorerChange}
          options={[
            { label: 'All scorers', value: '' },
            ...scorerOptions.map((s) => ({ label: s, value: s })),
          ]}
          value={scorer}
        />
        <Select
          appearance="pill"
          aria-label="Filter by source"
          onChange={(v) => {
            setSource(v as EvalSignalSourceValue | '');
            setOffset(0);
          }}
          options={SOURCE_OPTIONS}
          value={source}
        />
      </Toolbar>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="eval results"
        onRetry={() => void refetch()}
      >
        {/* Bleeds into the card's padding so cell text lines up with the toolbar above. */}
        <div className="-mx-4">
          <DataTable
            className="max-sm:px-4"
            columns={[
              {
                cell: (row) => (
                  <span className="font-mono text-sm" title={row.rationale ?? undefined}>
                    {row.scorer}
                  </span>
                ),
                header: 'Scorer',
                id: 'scorer',
                primary: true,
              },
              {
                align: 'right',
                cell: (row) => (
                  <span
                    className="text-sm font-medium tabular-nums"
                    style={{ color: scoreColor(row.value) }}
                  >
                    {formatScore(row)}
                  </span>
                ),
                header: 'Score',
                id: 'score',
              },
              {
                cell: (row) => <span className="text-xs text-paper-400">{row.source}</span>,
                header: 'Source',
                id: 'source',
              },
              {
                cell: (row) => (
                  <span className="text-xs text-paper-400">
                    <ResultRuntime row={row} />
                  </span>
                ),
                header: (
                  <span title="The implementer runtime the candidate arm ran on (and the baseline arm's, when it differs). Offline benchmark rows only.">
                    Runtime
                  </span>
                ),
                id: 'runtime',
                label: 'Runtime',
              },
              {
                cell: (row) => (
                  <span className="text-xs text-paper-400">
                    <ResultOrigin row={row} showEvalRun={!evalRunId} />
                  </span>
                ),
                header: 'Origin',
                id: 'origin',
              },
              {
                align: 'right',
                cell: (row) => (
                  <time
                    className="whitespace-nowrap text-xs text-paper-400"
                    dateTime={row.createdAt}
                    title={formatDate(row.createdAt)}
                  >
                    {formatRelativeTime(row.createdAt)}
                  </time>
                ),
                header: 'When',
                id: 'when',
              },
            ]}
            density="compact"
            empty={
              <EmptyState
                hint={
                  scorer || source
                    ? 'Try another scorer or source.'
                    : 'Results appear as scorers grade runs and benchmarks.'
                }
                icon="flask"
                title={scorer || source ? 'No eval results match' : 'No eval results yet'}
              />
            }
            getRowId={(row) => row.id}
            rows={rows}
          />
        </div>
      </QueryBoundary>
      {total > 0 && (
        <Pagination
          hasNext={offset + rows.length < total}
          hasPrev={offset > 0}
          onNext={() => setOffset((o) => o + LIMIT)}
          onPrev={() => setOffset((o) => Math.max(0, o - LIMIT))}
          rangeEnd={Math.min(offset + LIMIT, total)}
          rangeStart={offset + 1}
          total={total}
        />
      )}
    </div>
  );
}
