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
        className="font-mono text-ember-400 hover:underline"
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
        className="font-mono text-ember-400 hover:underline"
        href={`/govern/evals/runs/${row.evalRunId}`}
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
          <Table className="max-sm:px-4" stacked>
            <THead>
              <Th variant="plain">Scorer</Th>
              <Th align="right" variant="plain">
                Score
              </Th>
              <Th variant="plain">Source</Th>
              <Th variant="plain">
                <span title="The implementer runtime the candidate arm ran on (and the baseline arm's, when it differs). Offline benchmark rows only.">
                  Runtime
                </span>
              </Th>
              <Th variant="plain">Origin</Th>
              <Th align="right" variant="plain">
                When
              </Th>
            </THead>
            <tbody>
              {rows.map((row) => (
                <TRow hover key={row.id}>
                  <Td className="px-4 py-2.5 font-mono text-[13px] text-paper-100" primary>
                    <span title={row.rationale ?? undefined}>{row.scorer}</span>
                  </Td>
                  <Td align="right" className="px-4 py-2.5 text-[13px] font-medium" label="Score">
                    <span className="tabular-nums" style={{ color: scoreColor(row.value) }}>
                      {formatScore(row)}
                    </span>
                  </Td>
                  <Td className="px-4 py-2.5 text-xs text-paper-400" label="Source">
                    {row.source}
                  </Td>
                  <Td className="px-4 py-2.5 text-xs text-paper-400" label="Runtime">
                    <ResultRuntime row={row} />
                  </Td>
                  <Td className="px-4 py-2.5 text-xs text-paper-400" label="Origin">
                    <ResultOrigin row={row} showEvalRun={!evalRunId} />
                  </Td>
                  <Td align="right" className="px-4 py-2.5 text-xs text-paper-400" label="When">
                    <time
                      className="whitespace-nowrap"
                      dateTime={row.createdAt}
                      title={formatDate(row.createdAt)}
                    >
                      {formatRelativeTime(row.createdAt)}
                    </time>
                  </Td>
                </TRow>
              ))}
              {rows.length === 0 && (
                <TableStatusRow colSpan={6}>
                  <EmptyState
                    hint={
                      scorer || source
                        ? 'Try another scorer or source.'
                        : 'Results appear as scorers grade runs and benchmarks.'
                    }
                    icon="flask"
                    title={scorer || source ? 'No eval results match' : 'No eval results yet'}
                  />
                </TableStatusRow>
              )}
            </tbody>
          </Table>
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
