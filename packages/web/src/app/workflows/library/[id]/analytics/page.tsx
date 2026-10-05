'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
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
    isLoading,
  } = useWorkflowTemplateAnalytics(id ?? '', windowDays);

  const nodeTitles = nodeTitlesOf(template?.activeVersionSpec?.spec);
  const stepName = (nodeId: string) => nodeTitles.get(nodeId) ?? humanizeKey(nodeId);
  const steps = stats
    ? [...stats.perStepFailureRates]
        .filter((r) => r.total >= minRuns)
        .sort((a, b) => b.failureRate - a.failureRate || b.total - a.total)
    : [];
  const hiddenSteps = stats ? stats.perStepFailureRates.length - steps.length : 0;

  // Sections in render order — numbered from this one list so a conditional
  // section never leaves a gap or a duplicate.
  const sections = stats
    ? [
        stats.significanceHint && 'significance',
        stats.perVersionCounts.length > 1 && 'versions',
        stats.perOutcome.length > 0 && 'outcomes',
        'detail',
      ].filter(Boolean)
    : [];
  const sectionNumber = (key: string) => String(sections.indexOf(key) + 1).padStart(2, '0');

  if (!id) {
    return <TemplateNotFound />;
  }

  return (
    <div className="space-y-8">
      <div>
        <TemplateBackLink href={`/workflows/library/${id}`} label={template?.name ?? 'Workflow'} />
        <PageHeader
          actions={
            <Select
              className="w-auto"
              compact
              id="window"
              label="Window"
              onChange={(v) => setWindowDays(Number(v))}
              options={WINDOWS.map((w) => ({ label: `${w}d`, value: String(w) }))}
              value={String(windowDays)}
            />
          }
          chapter="§ Workflows"
          className="mb-0 mt-4"
          subtitle={`Observed performance and cost metrics for this workflow over the last ${windowDays} days.`}
          title="Observed performance"
        />
      </div>

      <TemplateSubNav active="analytics" templateId={id} />

      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={!isError && (isLoading || !stats)}
        label="analytics"
        loadingMessage="loading analytics…"
        onRetry={() => void refetch()}
      >
        {stats && stats.totalRuns === 0 && (
          <EmptyState
            hint="Run this template, or pick a longer window, and its success rate, cost and step failures will appear here."
            title={`No runs in the last ${windowDays} days.`}
          />
        )}
        {stats && stats.totalRuns > 0 && (
          <>
            {stats.isTruncated && (
              <Alert variant="warning">
                Analytics are limited to the most recent 10,000 runs or steps in this window.
              </Alert>
            )}
            <section className="grid grid-cols-2 gap-y-8 border-y border-ink-600 py-8 sm:grid-cols-4">
              <Stat label="Total runs" tone="ember" unit="runs" value={stats.totalRuns} />
              <Stat
                label="Success rate"
                tone={successTone(stats.successRate)}
                value={formatPercent(stats.successRate)}
              />
              <Stat label="p50 duration" value={formatDuration(stats.p50DurationMs)} />
              <Stat label="p95 duration" value={formatDuration(stats.p95DurationMs)} />
              <Stat label="Avg cost / run" tone="amber" value={formatCost(stats.avgCostPerRun)} />
              <Stat label="Total cost" value={formatCost(stats.totalCost)} />
              <Stat label="Succeeded" tone="moss" value={stats.succeeded} />
              <Stat
                label="Failed"
                tone={stats.failed > 0 ? 'brick' : 'default'}
                value={stats.failed}
              />
              <Stat
                label="Time saved"
                tone="moss"
                value={
                  stats.estimatedHumanTimeSavedTotal == null
                    ? '—'
                    : formatDuration(stats.estimatedHumanTimeSavedTotal * 60_000)
                }
              />
              <Stat label="Autonomy rate" value={formatPercent(stats.autonomyRate)} />
              <Stat label="Human review rate" value={formatPercent(stats.humanReviewRate)} />
            </section>

            {stats.significanceHint && (
              <section>
                <SectionHeader
                  hint="two-proportion z-test"
                  number={sectionNumber('significance')}
                  title="A/B significance"
                />
                <Card>
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-xs text-paper-400">
                      Success-rate comparison between the two most-trafficked versions. Treat this
                      as a hint, not a verdict — apply your own judgement before promoting.
                    </p>
                    <Badge
                      tone={stats.significanceHint.isSignificant ? 'moss' : 'amber'}
                      uppercase
                      variant="outline"
                    >
                      {stats.significanceHint.isSignificant
                        ? `Significant difference — v${
                            stats.significanceHint.successRateA >=
                            stats.significanceHint.successRateB
                              ? stats.significanceHint.versionA
                              : stats.significanceHint.versionB
                          } is better`
                        : 'No significant difference yet'}{' '}
                      · p=
                      {typeof stats.significanceHint.pValue === 'number'
                        ? stats.significanceHint.pValue.toFixed(3)
                        : '—'}
                    </Badge>
                  </div>
                  {Math.min(stats.significanceHint.nA, stats.significanceHint.nB) <
                    MIN_COMPARISON_RUNS && (
                    <Alert className="mb-3" variant="warning">
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
              </section>
            )}

            {stats.perVersionCounts.length > 1 && (
              <section>
                <SectionHeader
                  hint="traffic split"
                  number={sectionNumber('versions')}
                  title="Per-version run mix"
                />
                <Card>
                  <p className="mb-4 text-xs text-paper-400">
                    Useful for confirming the A/B traffic split is landing where you configured it.
                  </p>
                  <ul className="space-y-2">
                    {stats.perVersionCounts.map((v) => (
                      <li
                        className="flex items-center justify-between border-b border-ink-600 pb-2 last:border-b-0 last:pb-0"
                        key={v.version}
                      >
                        <span className="flex items-baseline gap-2 font-mono text-sm">
                          <span className="text-paper-100">v{v.version}</span>
                          <VersionTags
                            active={v.version === template?.activeVersion}
                            experiment={v.version === template?.experimentVersion}
                          />
                        </span>
                        <span className="tabular font-mono text-xs text-paper-300">
                          {v.count}
                          <span className="ml-2 text-paper-500">
                            ({formatPercent(stats.totalRuns > 0 ? v.count / stats.totalRuns : 0)})
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>
            )}

            {stats.perOutcome.length > 0 && (
              <section>
                <SectionHeader
                  hint="cost by outcome"
                  number={sectionNumber('outcomes')}
                  title="Outcomes"
                />
                <Card>
                  <p className="mb-4 text-xs text-paper-400">
                    Runs grouped by the type of outcome they produced.
                  </p>
                  <ul className="space-y-2">
                    {stats.perOutcome.map((o) => (
                      <li
                        className="flex items-center justify-between border-b border-ink-600 pb-2 last:border-b-0 last:pb-0"
                        key={o.outcomeType}
                      >
                        <span className="text-sm text-paper-100">
                          {outcomeTypeLabel(o.outcomeType)}
                        </span>
                        <span className="tabular font-mono text-xs text-paper-300">
                          {o.runCount} runs · {formatCost(o.totalCost)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>
            )}

            <section>
              <SectionHeader
                hint="highest failure rate first"
                number={sectionNumber('detail')}
                title="Step failure rates"
              />
              <Card>
                <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                  <p className="text-xs text-paper-400">
                    How often each step failed across its executions in this window. Skipped and
                    pending executions are left out.
                  </p>
                  <Select
                    className="w-auto"
                    compact
                    id="min-runs"
                    label="Show steps with at least"
                    onChange={(v) => setMinRuns(Number(v))}
                    options={MIN_RUNS_OPTIONS.map((n) => ({
                      label: n === 1 ? 'any number of runs' : `${n} runs`,
                      value: String(n),
                    }))}
                    value={String(minRuns)}
                  />
                </div>
                {steps.length === 0 ? (
                  <EmptyState
                    className="py-6"
                    title={
                      hiddenSteps > 0
                        ? `No step has run ${minRuns} times in this window yet.`
                        : 'No step executions recorded.'
                    }
                  />
                ) : (
                  <Table>
                    <THead>
                      <Th variant="compact">Step</Th>
                      <Th align="right" variant="compact">
                        Failed
                      </Th>
                      <Th align="right" variant="compact">
                        Runs
                      </Th>
                      <Th align="right" variant="compact">
                        Failure rate
                      </Th>
                    </THead>
                    <tbody>
                      {steps.map((row) => (
                        <TRow key={row.nodeId}>
                          <Td className="py-2 text-sm text-paper-200">
                            {row.failed > 0 ? (
                              <Link
                                className="hover:text-ember-400 hover:underline"
                                href={`/workflows/library/${id}/runs?failedStep=${encodeURIComponent(row.nodeId)}`}
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
                            className="tabular py-2 font-mono text-xs text-paper-300"
                          >
                            {row.failed}
                          </Td>
                          <Td
                            align="right"
                            className="tabular py-2 font-mono text-xs text-paper-300"
                          >
                            {row.total}
                          </Td>
                          <Td
                            align="right"
                            className={cn(
                              'tabular py-2 font-mono text-xs',
                              row.failureRate > 0.25
                                ? 'text-brick-400'
                                : row.failureRate > 0.05
                                  ? 'text-amber-400'
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
            </section>
          </>
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
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-paper-100">v{version}</span>
        <VersionTags active={active} experiment={experiment} />
      </div>
      <div className="tabular mt-2 font-display text-3xl font-light text-paper-100">
        {formatPercent(rate)}
      </div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-paper-500">
        {n} runs
      </div>
    </div>
  );
}
