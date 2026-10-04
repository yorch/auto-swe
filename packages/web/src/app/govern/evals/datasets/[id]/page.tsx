'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { EvalRunStatusBadge } from '@/components/evals/EvalRunStatusBadge';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useEvalDataset, useEvalRuns } from '@/hooks/useAdmin';
import { validateRouteParam } from '@/lib/routeParams';
import { formatDate } from '@/lib/utils';

const RUNS_LIMIT = 20;

export default function EvalDatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const id = validateRouteParam(use(params).id);
  const [runsOffset, setRunsOffset] = useState(0);
  const dataset = useEvalDataset(id);
  const runs = useEvalRuns(id, RUNS_LIMIT, runsOffset);
  const ds = dataset.data;
  const runRows = runs.data?.data ?? [];
  const runsTotal = runs.data?.meta.total ?? 0;

  return (
    <div className="space-y-8">
      <Link className="label-mono hover:text-paper-200" href="/govern/evals">
        ← Evals
      </Link>
      <QueryBoundary
        error={dataset.error}
        isError={dataset.isError}
        isFetching={dataset.isFetching}
        isLoading={dataset.isLoading}
        label="eval dataset"
        onRetry={() => void dataset.refetch()}
      >
        {ds && (
          <>
            <PageHeader
              chapter={`§ Govern · Evals · ${ds.scope}`}
              subtitle={ds.description ?? undefined}
              title={ds.name}
            />

            <Card>
              <CardHeader>
                <CardTitle eyebrow="Offline harness runs, newest first">Runs</CardTitle>
              </CardHeader>
              <QueryBoundary
                error={runs.error}
                isError={runs.isError}
                isFetching={runs.isFetching}
                isLoading={runs.isLoading}
                label="eval runs"
                onRetry={() => void runs.refetch()}
              >
                <Table>
                  <THead>
                    <Th variant="dense">Started</Th>
                    <Th variant="dense">Status</Th>
                    <Th variant="dense">Candidate</Th>
                    <Th variant="dense">Baseline</Th>
                  </THead>
                  <tbody>
                    {runRows.map((r) => (
                      <TRow hover key={r.id}>
                        <Td className="px-4 py-2 font-mono text-[11px]">
                          <Link
                            className="text-ember-400 hover:underline"
                            href={`/govern/evals/runs/${r.id}`}
                          >
                            {formatDate(r.startedAt)}
                          </Link>
                        </Td>
                        <Td className="px-4 py-2">
                          <EvalRunStatusBadge partial={r.partial} status={r.status} />
                        </Td>
                        <Td className="px-4 py-2 font-mono text-[11px] text-paper-300">
                          {r.candidateRef}
                        </Td>
                        <Td className="px-4 py-2 font-mono text-[11px] text-paper-400">
                          {r.baselineRef}
                        </Td>
                      </TRow>
                    ))}
                    {runRows.length === 0 && (
                      <TableStatusRow colSpan={4}>
                        <EmptyState hint="Start one with the CLI." title="No runs yet." />
                      </TableStatusRow>
                    )}
                  </tbody>
                </Table>
              </QueryBoundary>
              {runsTotal > RUNS_LIMIT && (
                <div className="mt-3">
                  <Pagination
                    hasNext={runsOffset + runRows.length < runsTotal}
                    hasPrev={runsOffset > 0}
                    onNext={() => setRunsOffset((o) => o + RUNS_LIMIT)}
                    onPrev={() => setRunsOffset((o) => Math.max(0, o - RUNS_LIMIT))}
                    rangeEnd={Math.min(runsOffset + RUNS_LIMIT, runsTotal)}
                    rangeStart={runsOffset + 1}
                    total={runsTotal}
                  />
                </div>
              )}
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Cases ({ds.caseCount})</CardTitle>
              </CardHeader>
              <Table>
                <THead>
                  <Th variant="dense">Repository</Th>
                  <Th variant="dense">Baseline</Th>
                  <Th variant="dense">Golden test</Th>
                  <Th variant="dense">Tags</Th>
                  <Th variant="dense">Flake screen</Th>
                </THead>
                <tbody>
                  {ds.cases.map((c) => (
                    <TRow key={c.id}>
                      <Td className="px-4 py-2 font-mono text-[11px] text-paper-300">
                        <span title={c.id}>{c.repoUrl}</span>
                      </Td>
                      <Td className="px-4 py-2 font-mono text-[11px] text-paper-400">
                        <span title={c.baselineSha}>{c.baselineSha.slice(0, 10)}</span>
                      </Td>
                      <Td className="px-4 py-2 font-mono text-[11px] text-paper-400">
                        <span className="line-clamp-2">{c.goldenTest}</span>
                      </Td>
                      <Td className="px-4 py-2 font-mono text-[11px] text-paper-500">
                        {c.tags.length ? c.tags.join(', ') : '—'}
                      </Td>
                      <Td className="px-4 py-2 font-mono text-[11px] text-paper-500">
                        {c.flakeScreened ? `screened (${c.flakeRuns} runs)` : 'not screened'}
                      </Td>
                    </TRow>
                  ))}
                  {ds.cases.length === 0 && (
                    <TableStatusRow colSpan={5}>
                      <EmptyState title="This dataset has no cases." />
                    </TableStatusRow>
                  )}
                </tbody>
              </Table>
            </Card>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
