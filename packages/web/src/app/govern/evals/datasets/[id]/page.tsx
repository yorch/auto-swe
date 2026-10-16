'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { EvalRunStatusBadge } from '@/components/evals/EvalRunStatusBadge';
import { Alert } from '@/components/ui/Alert';
import { BackLink } from '@/components/ui/BackLink';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useEvalDataset, useEvalRuns, useRescreenEvalCases } from '@/hooks/useAdmin';
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
  const rescreen = useRescreenEvalCases(id ?? '');
  // The re-check awaiting confirmation: one case, or (no caseId) the whole dataset.
  const [confirmRescreen, setConfirmRescreen] = useState<{ caseId?: string } | null>(null);
  const [rescreenNote, setRescreenNote] = useState<string | null>(null);
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
                <dd className="mt-0.5 font-mono text-sm text-paper-200">{ds.slug}</dd>
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
                <span className="flex items-center gap-3">
                  <span className="text-xs text-paper-500 tabular-nums">
                    {ds.caseCount} case{ds.caseCount === 1 ? '' : 's'}
                  </span>
                  {ds.cases.length > 0 && (
                    <Button onClick={() => setConfirmRescreen({})} size="sm">
                      Re-check all
                    </Button>
                  )}
                </span>
              </CardHeader>
              {rescreenNote && (
                <Alert className="mb-3" variant="info">
                  {rescreenNote}
                </Alert>
              )}
              <div className="-mx-4">
                <Table className="max-sm:px-4" stacked>
                  <THead>
                    <Th variant="plain">Repository</Th>
                    <Th variant="plain">Baseline</Th>
                    <Th variant="plain">Golden test</Th>
                    <Th variant="plain">Tags</Th>
                    <Th variant="plain">
                      <span title="Each case's golden test is run several times at its pinned commit; a case that fails any run is flaky, and the benchmark does not score it, so it cannot skew a verdict. Re-check one after fixing what made it fail.">
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
                            {/* A failed check (runs recorded, no pass) is skipped like an unchecked case. */}
                            <Badge
                              dot
                              tone={c.flakeScreened ? 'moss' : c.flakeRuns > 0 ? 'amber' : 'muted'}
                              variant="text"
                            >
                              {c.flakeScreened
                                ? `Checked (${c.flakeRuns} runs)`
                                : c.screenEnvironmentFailed
                                  ? "Couldn't be checked (its runs kept being killed or timing out)"
                                  : c.flakeRuns > 0
                                    ? `Flaky (failed a ${c.flakeRuns}-run check)`
                                    : 'Not checked yet'}
                            </Badge>
                            {c.flakeRuns > 0 && (
                              <Button
                                aria-label={`Re-check case ${c.id}`}
                                className="ml-2"
                                onClick={() => setConfirmRescreen({ caseId: c.id })}
                                size="sm"
                                variant="ghost"
                              >
                                Re-check
                              </Button>
                            )}
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
            <ConfirmModal
              confirmLabel="Re-check"
              message={
                confirmRescreen?.caseId
                  ? 'This case goes back to "Not checked yet" and is checked again. Until that check passes, benchmark runs do not score it.'
                  : 'Every case goes back to "Not checked yet" and is checked again. Until a case passes its check, benchmark runs do not score it, so runs in the meantime may be inconclusive.'
              }
              onClose={() => setConfirmRescreen(null)}
              onConfirm={async () => {
                const r = await rescreen.mutateAsync(confirmRescreen?.caseId);
                setRescreenNote(
                  r.screenStarted
                    ? `${r.reset} case${r.reset === 1 ? '' : 's'} reset; the stability check has started.`
                    : `${r.reset} case${r.reset === 1 ? '' : 's'} reset. The check could not start now; the next benchmark run of this dataset starts it.`
                );
              }}
              open={confirmRescreen !== null}
              title={confirmRescreen?.caseId ? 'Re-check this case?' : 'Re-check every case?'}
            />
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
