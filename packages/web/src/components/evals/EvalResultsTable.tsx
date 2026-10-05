'use client';

import {
  EVAL_SIGNAL_SOURCES,
  type EvalResultDto,
  type EvalSignalSourceValue,
} from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useEvalResults } from '@/hooks/useAdmin';
import { formatDate, scoreColor } from '@/lib/utils';

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

/** Where a result came from: the workflow run it scored, or the harness run and case. */
function ResultOrigin({ row, showEvalRun }: { row: EvalResultDto; showEvalRun: boolean }) {
  if (row.runId) {
    return (
      <Link
        className="text-ember-400 hover:underline"
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
        className="text-ember-400 hover:underline"
        href={`/govern/evals/runs/${row.evalRunId}`}
        title={row.evalRunId}
      >
        eval run {row.evalRunId.slice(0, 8)}
      </Link>
    );
  }
  if (row.caseId) {
    return <span title={row.caseId}>case {row.caseId.slice(0, 8)}</span>;
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Select
          aria-label="Filter by scorer"
          onChange={onScorerChange}
          options={[
            { label: 'All scorers', value: '' },
            ...scorerOptions.map((s) => ({ label: s, value: s })),
          ]}
          value={scorer}
        />
        <Select
          aria-label="Filter by source"
          onChange={(v) => {
            setSource(v as EvalSignalSourceValue | '');
            setOffset(0);
          }}
          options={SOURCE_OPTIONS}
          value={source}
        />
      </div>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="eval results"
        onRetry={() => void refetch()}
      >
        <Table stacked>
          <THead>
            <Th variant="dense">Time</Th>
            <Th variant="dense">Source</Th>
            <Th variant="dense">Scorer</Th>
            <Th align="right" variant="dense">
              Score
            </Th>
            <Th variant="dense">Origin</Th>
          </THead>
          <tbody>
            {rows.map((row) => (
              <TRow hover key={row.id}>
                <Td className="px-4 py-2 font-mono text-[11px] text-paper-400" primary>
                  {formatDate(row.createdAt)}
                </Td>
                <Td className="px-4 py-2 font-mono text-[11px] text-paper-400" label="Source">
                  {row.source}
                </Td>
                <Td className="px-4 py-2 font-mono text-[11px] text-paper-200" label="Scorer">
                  <span title={row.rationale ?? undefined}>{row.scorer}</span>
                </Td>
                <Td align="right" className="px-4 py-2 font-mono text-[11px]" label="Score">
                  <span className="num" style={{ color: scoreColor(row.value) }}>
                    {formatScore(row)}
                  </span>
                </Td>
                <Td className="px-4 py-2 font-mono text-[11px] text-paper-500" label="Origin">
                  <ResultOrigin row={row} showEvalRun={!evalRunId} />
                </Td>
              </TRow>
            ))}
            {rows.length === 0 && (
              <TableStatusRow colSpan={5}>
                <EmptyState title="No eval results match." />
              </TableStatusRow>
            )}
          </tbody>
        </Table>
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
