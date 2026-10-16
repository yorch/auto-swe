'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { Skeleton } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Stat } from '@/components/ui/Stat';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  TemplateBackLink,
  TemplateNotFound,
  TemplateSubNav,
} from '@/components/workflow/templateNav';
import { VersionTags } from '@/components/workflow/VersionTags';
import { useWorkflowTemplate, useWorkflowTemplateAnalytics } from '@/hooks/useTemplates';
import { humanizeKey, outcomeTypeLabel } from '@/lib/govLabels';
import { nodeTitlesOf } from '@/lib/nodeTitles';
import { validateRouteParam } from '@/lib/routeParams';
import { successTone } from '@/lib/tone';
import { cn, formatCost, formatDuration, formatPercent } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

const WINDOWS = [7, 14, 30, 90] as const;

/** Steps that ran fewer times than this in the window are hidden by default: a rate over 2 runs is noise. */
const MIN_RUNS_OPTIONS = [1, 5, 10, 20] as const;
/** Below this many runs on either side, a version comparison is too thin to lean on. */
const MIN_COMPARISON_RUNS = 30;

export default function TemplateAnalyticsPage({ params }: PageProps) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const [windowDays, setWindowDays] = useState<number>(30);
  const [minRuns, setMinRuns] = useState<number>(5);
  const { data: template } = useWorkflowTemplate(id ?? '');
  const {
    data: stats,
    error,
    isError,
    isFetching,
    refetch,
  } = useWorkflowTemplateAnalytics(id ?? '', windowDays);

  const nodeTitles = nodeTitlesOf(template?.activeVersionSpec?.spec);
  const stepName = (nodeId: string) => nodeTitles.get(nodeId) ?? humanizeKey(nodeId);
  const steps = stats
    ? [...stats.perStepFailureRates]
        .filter((r) => r.total >= minRuns)
        .sort((a, b) => b.failureRate - a.failureRate || b.total - a.total)
    : [];
  const hiddenSteps = stats ? stats.perStepFailureRates.length - steps.length : 0;

  if (!id) {
    return <TemplateNotFound />;
  }

  const runnable = template?.status === 'ACTIVE' && template.activeVersion !== null;
  const maxVersionCount = stats ? Math.max(1, ...stats.perVersionCounts.map((v) => v.count)) : 1;

  return (
    <div className="space-y-6">
      <div>
        <TemplateBackLink href={`/library/${id}`} label={template?.name ?? 'Workflow'} />
        <PageHeader
          actions={
            <SegmentedControl
              ariaLabel="Time window"
              onChange={(v) => setWindowDays(Number(v))}
              options={WINDOWS.map((w) => ({
                label: `${w}d`,
                title: `Last ${w} days`,
                value: String(w),
              }))}
              value={String(windowDays)}
            />
          }
          className="mt-3 mb-0"
          subtitle={`How this workflow performed over the last ${windowDays} days: outcomes, cost, and which steps fail.`}
          title="Analytics"
        />
      </div>

      <TemplateSubNav active="analytics" templateId={id} />

      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={false}
        label="analytics"
        onRetry={() => void refetch()}
      >
        {!stats && !isError && (
          <Card>
            <div
              aria-busy="true"
              aria-live="polite"
              className="grid grid-cols-2 gap-6 sm:grid-cols-4"
              role="status"
            >
              <span className="sr-only">Loading analytics</span>
              {['a', 'b', 'c', 'd'].map((k) => (
                <div className="space-y-3" key={k}>
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-9 w-20" />
                </div>
              ))}
            </div>
          </Card>
        )}
        {stats && stats.totalRuns === 0 && (
          <EmptyState
            action={
              <>
                {windowDays < 90 && (
                  <Button onClick={() => setWindowDays(90)} size="sm">
                    Show the last 90 days
                  </Button>
                )}
                {runnable && (
                  <ButtonLink
                    href={`/start?template=${encodeURIComponent(id)}`}
                    size="sm"
                    variant="primary"
                  >
                    Run this workflow
                  </ButtonLink>
                )}
              </>
            }
            bordered
            hint="Run this workflow, or pick a longer window, and its success rate, cost and step failures appear here."
            icon="analytics"
            title={`No runs in the last ${windowDays} days`}
          />
        )}
        {stats && stats.totalRuns > 0 && (
          <div className="space-y-6">
            {stats.isTruncated && (
              <Alert variant="warning">
                Analytics are limited to the most recent 10,000 runs or steps in this window.
              </Alert>
            )}
            <Card>
              <CardHeader>
                <CardTitle hint={`Last ${windowDays} days`}>Overview</CardTitle>
              </CardHeader>
              <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
                <Stat label="Total runs" unit="runs" value={stats.totalRuns} />
                <Stat
                  hint={
                    <HelpTip label="Success rate">
                      Succeeded runs divided by runs that finished as a success or a failure.
                      Skipped and still-running runs are not counted.
                    </HelpTip>
                  }
                  label="Success rate"
                  tone={successTone(stats.successRate)}
                  value={formatPercent(stats.successRate)}
                />
                <Stat label="Succeeded" tone="success" value={stats.succeeded} />
                <Stat
                  label="Failed"
                  tone={stats.failed > 0 ? 'danger' : 'default'}
                  value={stats.failed}
                />
                <Stat
                  hint={
                    <HelpTip label="p50 duration">
                      The median run time: half of finished runs took this long or less.
                    </HelpTip>
                  }
                  label="p50 duration"
                  value={formatDuration(stats.p50DurationMs)}
                />
                <Stat
                  hint={
                    <HelpTip label="p95 duration">
                      19 in 20 finished runs took this long or less. It shows the slow tail.
                    </HelpTip>
                  }
                  label="p95 duration"
                  value={formatDuration(stats.p95DurationMs)}
                />
                <Stat label="Avg cost / run" value={formatCost(stats.avgCostPerRun)} />
                <Stat label="Total cost" value={formatCost(stats.totalCost)} />
                <Stat
                  hint={
                    <HelpTip label="Time saved">
                      The template’s “Estimated human time saved” per run, added up over the runs in
                      this window. Each run records the estimate when it starts, so it counts only
                      runs started after someone sets it under Edit details.
                    </HelpTip>
                  }
                  label="Time saved"
                  tone="success"
                  value={
                    stats.estimatedHumanTimeSavedTotal == null
                      ? '—'
                      : formatDuration(stats.estimatedHumanTimeSavedTotal * 60_000)
                  }
                />
                <Stat
                  hint={
                    <HelpTip label="Autonomy rate">
                      The share of finished runs that had no human step, made at least one autonomy
                      decision, and had every publish action allowed automatically by the policy.
                    </HelpTip>
                  }
                  label="Autonomy rate"
                  value={formatPercent(stats.autonomyRate)}
                />
                <Stat
                  hint={
                    <HelpTip label="Human review rate">
                      The share of finished runs that stopped at a human step, such as an approval
                      or a review.
                    </HelpTip>
                  }
                  label="Human review rate"
                  value={formatPercent(stats.humanReviewRate)}
                />
              </div>
            </Card>

            {stats.significanceHint && (
              <Card>
                <CardHeader>
                  <CardTitle hint="Two-proportion z-test">A/B significance</CardTitle>
                  <Badge
                    dot
                    tone={stats.significanceHint.isSignificant ? 'success' : 'warning'}
                    variant="outline"
                  >
                    {stats.significanceHint.isSignificant
                      ? `Significant difference — v${
                          stats.significanceHint.successRateA >= stats.significanceHint.successRateB
                            ? stats.significanceHint.versionA
                            : stats.significanceHint.versionB
                        } is better`
                      : 'No significant difference yet'}{' '}
                    · p=
                    {typeof stats.significanceHint.pValue === 'number'
                      ? stats.significanceHint.pValue.toFixed(3)
                      : '—'}
                  </Badge>
                </CardHeader>
                <p className="mb-4 max-w-2xl text-sm leading-relaxed text-paper-400">
                  Success-rate comparison between the two most-trafficked versions. Treat this as a
                  hint, not a verdict — apply your own judgement before promoting.
                </p>
                {Math.min(stats.significanceHint.nA, stats.significanceHint.nB) <
                  MIN_COMPARISON_RUNS && (
                  <Alert className="mb-4" variant="warning">
                    One version has fewer than {MIN_COMPARISON_RUNS} runs, so this comparison is
                    unreliable. Wait for more traffic before acting on it.
                  </Alert>
                )}
                <div className="grid grid-cols-2 gap-x-8 gap-y-4 border-t border-ink-600 pt-4">
                  <VersionComparison
                    active={stats.significanceHint.versionA === template?.activeVersion}
                    n={stats.significanceHint.nA}
                    rate={stats.significanceHint.successRateA}
                    version={stats.significanceHint.versionA}
                  />
                  <VersionComparison
                    experiment={stats.significanceHint.versionB === template?.experimentVersion}
                    n={stats.significanceHint.nB}
                    rate={stats.significanceHint.successRateB}
                    version={stats.significanceHint.versionB}
                  />
                </div>
              </Card>
            )}

            {(stats.perVersionCounts.length > 1 || stats.perOutcome.length > 0) && (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {stats.perVersionCounts.length > 1 && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Runs per version</CardTitle>
                    </CardHeader>
                    <p className="mb-4 text-sm text-paper-400">
                      Confirms the A/B traffic split lands where you configured it.
                    </p>
                    <ul className="space-y-3">
                      {stats.perVersionCounts.map((v) => (
                        <li key={v.version}>
                          <div className="flex items-center justify-between gap-3 text-sm">
                            <span className="flex items-center gap-2">
                              <span className="font-medium text-paper-100 tabular-nums">
                                v{v.version}
                              </span>
                              <VersionTags
                                active={v.version === template?.activeVersion}
                                experiment={v.version === template?.experimentVersion}
                              />
                            </span>
                            <span className="text-paper-300 tabular-nums">
                              {v.count}
                              <span className="ml-2 text-paper-500">
                                {formatPercent(stats.totalRuns > 0 ? v.count / stats.totalRuns : 0)}
                              </span>
                            </span>
                          </div>
                          <div aria-hidden className="mt-1.5 h-1.5 rounded-full bg-ink-600">
                            <div
                              className="h-full rounded-full bg-paper-400/70"
                              style={{ width: `${(v.count / maxVersionCount) * 100}%` }}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}

                {stats.perOutcome.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle hint="Cost by outcome">Outcomes</CardTitle>
                    </CardHeader>
                    <p className="mb-4 text-sm text-paper-400">
                      Runs grouped by the type of outcome they produced.
                    </p>
                    <ul className="divide-y divide-ink-600">
                      {stats.perOutcome.map((o) => (
                        <li
                          className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                          key={o.outcomeType}
                        >
                          <span className="text-sm text-paper-100">
                            {outcomeTypeLabel(o.outcomeType)}
                          </span>
                          <span className="text-sm text-paper-300 tabular-nums">
                            {o.runCount} runs
                            <span className="ml-2 text-paper-500">{formatCost(o.totalCost)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </div>
            )}

            <Card>
              <CardHeader>
                <CardTitle hint="Highest failure rate first">Step failure rates</CardTitle>
                <Select
                  aria-label="Minimum runs per step"
                  className="h-8 w-full text-sm sm:w-56"
                  compact
                  id="min-runs"
                  onChange={(v) => setMinRuns(Number(v))}
                  options={MIN_RUNS_OPTIONS.map((n) => ({
                    label: n === 1 ? 'Every step' : `Steps with ${n}+ runs`,
                    value: String(n),
                  }))}
                  value={String(minRuns)}
                />
              </CardHeader>
              <p className="mb-4 max-w-2xl text-sm text-paper-400">
                How often each step failed across its executions in this window. Skipped and pending
                executions are left out. Select a failing step to see its runs.
              </p>
              {steps.length === 0 ? (
                <EmptyState
                  action={
                    hiddenSteps > 0 ? (
                      <Button onClick={() => setMinRuns(1)} size="sm">
                        Show every step
                      </Button>
                    ) : undefined
                  }
                  className="py-6"
                  icon={null}
                  title={
                    hiddenSteps > 0
                      ? `No step has run ${minRuns} times in this window yet`
                      : 'No step executions recorded'
                  }
                />
              ) : (
                <Table>
                  <THead>
                    <Th className="pl-0" variant="plain">
                      Step
                    </Th>
                    <Th align="right" variant="plain">
                      Failed
                    </Th>
                    <Th align="right" variant="plain">
                      Runs
                    </Th>
                    <Th align="right" className="pr-0" variant="plain">
                      Failure rate
                    </Th>
                  </THead>
                  <tbody>
                    {steps.map((row) => (
                      <TRow hover={row.failed > 0} key={row.nodeId}>
                        <Td className="py-2.5 pr-4 text-sm text-paper-200">
                          {row.failed > 0 ? (
                            <Link
                              className="rounded-sm text-paper-100 underline-offset-2 hover:underline focus-visible:underline"
                              href={`/library/${id}/runs?failedStep=${encodeURIComponent(row.nodeId)}`}
                              title="See the runs where this step failed"
                            >
                              {stepName(row.nodeId)}
                            </Link>
                          ) : (
                            stepName(row.nodeId)
                          )}
                        </Td>
                        <Td
                          align="right"
                          className="px-4 py-2.5 text-sm text-paper-300 tabular-nums"
                        >
                          {row.failed}
                        </Td>
                        <Td
                          align="right"
                          className="px-4 py-2.5 text-sm text-paper-300 tabular-nums"
                        >
                          {row.total}
                        </Td>
                        <Td
                          align="right"
                          className={cn(
                            'py-2.5 pl-4 text-sm font-medium tabular-nums',
                            row.failureRate > 0.25
                              ? 'text-danger-400'
                              : row.failureRate > 0.05
                                ? 'text-warning-400'
                                : 'text-paper-500'
                          )}
                        >
                          {formatPercent(row.failureRate)}
                        </Td>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              )}
              {hiddenSteps > 0 && steps.length > 0 && (
                <p className="mt-3 text-xs text-paper-500">
                  {hiddenSteps} {hiddenSteps === 1 ? 'step' : 'steps'} with fewer than {minRuns}{' '}
                  runs hidden.
                </p>
              )}
            </Card>
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

function VersionComparison({
  active = false,
  experiment = false,
  n,
  rate,
  version,
}: {
  active?: boolean;
  experiment?: boolean;
  n: number;
  rate: number;
  version: number;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-paper-100 tabular-nums">v{version}</span>
        <VersionTags active={active} experiment={experiment} />
      </div>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-paper-100 tabular-nums">
        {formatPercent(rate)}
      </div>
      <div className="mt-1 text-xs text-paper-500 tabular-nums">{n} runs</div>
    </div>
  );
}
