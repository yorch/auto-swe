'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { EvalRunStatusBadge } from '@/components/evals/EvalRunStatusBadge';
import { BackLink } from '@/components/govern/BackLink';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useEvalDataset, useEvalRuns } from '@/hooks/useAdmin';
import { formatArm } from '@/lib/evalRuntime';
import { validateRouteParam } from '@/lib/routeParams';
import { cn, FOCUS_RING, formatDate, formatRelativeTime } from '@/lib/utils';

const RUNS_LIMIT = 20;
const CASES_PAGE_SIZE = 25;

export default function EvalDatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const id = validateRouteParam(use(params).id);
  const [runsOffset, setRunsOffset] = useState(0);
  const [casesPage, setCasesPage] = useState(0);
  const dataset = useEvalDataset(id);
  const runs = useEvalRuns(id, RUNS_LIMIT, runsOffset);
  const ds = dataset.data;
  const runRows = runs.data?.data ?? [];
  const runsTotal = runs.data?.meta.total ?? 0;

  return (
    <div className="space-y-6">
      <BackLink href="/govern/evals" label="Evals" />
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
            <PageHeader className="mb-2" subtitle={ds.description ?? undefined} title={ds.name} />
            <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-paper-500">Slug</dt>
                <dd className="mt-0.5 font-mono text-[13px] text-paper-200">{ds.slug}</dd>
              </div>
              <div>
                <dt className="text-xs text-paper-500">Cases</dt>
                <dd className="mt-0.5 text-paper-200 tabular-nums">{ds.caseCount}</dd>
              </div>
              <div>
                <dt className="text-xs text-paper-500">Runs</dt>
                <dd className="mt-0.5 text-paper-200 tabular-nums">
                  {runs.isLoading ? '…' : runsTotal}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-paper-500">Stability-checked</dt>
                <dd className="mt-0.5 text-paper-200 tabular-nums">
                  {ds.cases.filter((c) => c.flakeScreened).length} of {ds.cases.length}
                </dd>
              </div>
            </dl>

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
                <div className="-mx-4">
                  <Table className="max-sm:px-4" stacked>
                    <THead>
                      <Th variant="plain">Started</Th>
                      <Th variant="plain">Status</Th>
                      <Th variant="plain">Candidate</Th>
                      <Th variant="plain">Baseline</Th>
                    </THead>
                    <tbody>
                      {runRows.map((r) => (
                        <TRow hover key={r.id}>
                          <Td className="px-4 py-2.5" primary>
                            <Link
                              className={cn(
                                'rounded-sm font-medium text-paper-100 hover:text-ember-300',
                                FOCUS_RING
                              )}
                              href={`/govern/evals/runs/${r.id}`}
                              title={formatDate(r.startedAt)}
                            >
                              {formatRelativeTime(r.startedAt)}
                            </Link>
                          </Td>
                          <Td className="px-4 py-2.5" label="Status">
                            <EvalRunStatusBadge partial={r.partial} status={r.status} />
                          </Td>
                          <Td
                            className="px-4 py-2.5 font-mono text-xs text-paper-200"
                            label="Candidate"
                          >
                            {formatArm(r.candidateRef, r.candidateRuntime)}
                          </Td>
                          <Td
                            className="px-4 py-2.5 font-mono text-xs text-paper-400"
                            label="Baseline"
                          >
                            {formatArm(r.baselineRef, r.baselineRuntime)}
                          </Td>
                        </TRow>
                      ))}
                      {runRows.length === 0 && (
                        <TableStatusRow colSpan={4}>
                          <EmptyState
                            hint={
                              <>
                                Start one with{' '}
                                <code className="font-mono text-paper-300">
                                  auto-swe evals run {ds.slug} --candidate=&lt;ref&gt;
                                  --against=&lt;ref&gt;
                                </code>
                              </>
                            }
                            icon="flask"
                            title="No runs yet"
                          />
                        </TableStatusRow>
                      )}
                    </tbody>
                  </Table>
                </div>
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
                <CardTitle eyebrow="Golden cases">Cases</CardTitle>
                <span className="text-xs text-paper-500 tabular-nums">
                  {ds.caseCount} case{ds.caseCount === 1 ? '' : 's'}
                </span>
              </CardHeader>
              <div className="-mx-4">
                <Table className="max-sm:px-4" stacked>
                  <THead>
                    <Th variant="plain">Repository</Th>
                    <Th variant="plain">Baseline</Th>
                    <Th variant="plain">Golden test</Th>
                    <Th variant="plain">Tags</Th>
                    <Th variant="plain">
                      <span title="Each case is re-run several times on the baseline; cases that pass only some of the time are flaky and get quarantined so they cannot skew a verdict.">
                        Stability check
                      </span>
                    </Th>
                  </THead>
                  <tbody>
                    {ds.cases
                      .slice(casesPage * CASES_PAGE_SIZE, (casesPage + 1) * CASES_PAGE_SIZE)
                      .map((c) => (
                        <TRow key={c.id}>
                          <Td className="px-4 py-2.5 font-mono text-xs text-paper-200" primary>
                            <span className="break-all" title={c.id}>
                              {c.repoUrl}
                            </span>
                          </Td>
                          <Td
                            className="px-4 py-2.5 font-mono text-xs text-paper-400"
                            label="Baseline"
                          >
                            <span title={c.baselineSha}>{c.baselineSha.slice(0, 10)}</span>
                          </Td>
                          <Td
                            className="px-4 py-2.5 font-mono text-xs text-paper-400"
                            label="Golden test"
                          >
                            <span className="line-clamp-2" title={c.goldenTest}>
                              {c.goldenTest}
                            </span>
                          </Td>
                          <Td className="px-4 py-2.5" label="Tags">
                            {c.tags.length ? (
                              <span className="flex flex-wrap gap-1">
                                {c.tags.map((t) => (
                                  <Badge key={t} tone="muted" variant="outline">
                                    {t}
                                  </Badge>
                                ))}
                              </span>
                            ) : (
                              <span className="text-paper-500">—</span>
                            )}
                          </Td>
                          <Td className="px-4 py-2.5" label="Stability check">
                            <Badge dot tone={c.flakeScreened ? 'moss' : 'muted'} variant="text">
                              {c.flakeScreened
                                ? `Checked (${c.flakeRuns} runs)`
                                : 'Not checked yet'}
                            </Badge>
                          </Td>
                        </TRow>
                      ))}
                    {ds.cases.length === 0 && (
                      <TableStatusRow colSpan={5}>
                        <EmptyState
                          hint="Cases are added through the platform API when the dataset is created."
                          icon="layers"
                          title="This dataset has no cases"
                        />
                      </TableStatusRow>
                    )}
                  </tbody>
                </Table>
              </div>
              {ds.cases.length > CASES_PAGE_SIZE && (
                <div className="mt-3">
                  <Pagination
                    hasNext={(casesPage + 1) * CASES_PAGE_SIZE < ds.cases.length}
                    hasPrev={casesPage > 0}
                    onNext={() => setCasesPage((p) => p + 1)}
                    onPrev={() => setCasesPage((p) => Math.max(0, p - 1))}
                    rangeEnd={Math.min((casesPage + 1) * CASES_PAGE_SIZE, ds.cases.length)}
                    rangeStart={casesPage * CASES_PAGE_SIZE + 1}
                    total={ds.cases.length}
                  />
                </div>
              )}
            </Card>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
