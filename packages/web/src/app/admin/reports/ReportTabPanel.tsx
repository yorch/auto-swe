'use client';

import { EmptyState } from '@/components/ui/EmptyState';

export type ReportTab = 'delivery' | 'quality' | 'budget' | 'automations' | 'hitl';

export interface DeliveryReportData {
  byRepo: Array<{ repoId: string; repositoryName: string; runsStarted: number; spendUsd: number }>;
  byTemplate: Array<{ templateId: string; templateName: string; runsStarted: number }>;
  costPerMergedPr: number | null;
  medianTimeToMergeMs: number | null;
  prsCiPassed: number;
  prsMerged: number;
  runsStarted: number;
  runsSucceeded: number;
  runsWithPr: number;
}

export interface QualityReportData {
  ciSelfHealRate: number | null;
  fixLoops: Array<{
    avgRoundsPerRun: number | null;
    runsWithFix: number;
    stepName: string;
    totalRounds: number;
  }>;
  gates: Array<{
    failed: number;
    passRate: number | null;
    passed: number;
    stepName: string;
    total: number;
  }>;
  review: {
    byReviewer: Array<{
      approvalRate: number | null;
      findingsTotal: number;
      reviewer: string;
      verdicts: number;
    }>;
    unparseableRows: number;
  };
}

export interface BudgetReportData {
  organizations: Array<{
    lowConfidence: boolean;
    mtdUsd: number;
    name: string;
    orgId: string;
    projectedUsd: number;
    status: string;
    topRuns: Array<{ costUsd: number; id: string; workflowId: string }>;
  }>;
}

export interface AutomationReportData {
  automations: Array<{
    automationId: string | null;
    automationName: string;
    broken: boolean;
    fires: number;
    noisy: boolean;
    started: number;
    suppressed: { share: number; total: number };
  }>;
}

export interface HitlReportData {
  autonomy: { byEvent: Record<string, number>; byRiskClass: Record<string, number> };
  byApprover: Array<{ medianWaitMs: number | null; name: string; resolved: number }>;
  medianWaitMs: number | null;
  oldestPendingAgeMs: number | null;
  pendingNow: number;
  timedOut: number;
}

export type ReportTabData =
  | DeliveryReportData
  | QualityReportData
  | BudgetReportData
  | AutomationReportData
  | HitlReportData;

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function duration(value: number | null): string {
  if (value === null) {
    return '—';
  }
  const hours = value / 3_600_000;
  return hours >= 24 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} hours`;
}

export function ReportTabPanel({ data, tab }: { data: ReportTabData; tab: ReportTab }) {
  if (tab === 'delivery') {
    const report = data as DeliveryReportData;
    if (report.runsStarted === 0) {
      return (
        <EmptyState
          hint="Workflow runs appear here when they start."
          title="No delivery data yet"
        />
      );
    }
    return (
      <section aria-label="Delivery report" className="space-y-5">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Runs started" value={report.runsStarted} />
          <Metric label="Runs succeeded" value={report.runsSucceeded} />
          <Metric label="Runs with PRs" value={report.runsWithPr} />
          <Metric label="Merged PRs" value={report.prsMerged} />
          <Metric label="CI-passed PRs" value={report.prsCiPassed} />
          <Metric
            label="Cost per merged PR"
            value={report.costPerMergedPr === null ? '—' : `$${report.costPerMergedPr.toFixed(2)}`}
          />
          <Metric label="Median time to merge" value={duration(report.medianTimeToMergeMs)} />
        </dl>
        <h2 className="text-lg font-semibold text-paper-100">By template</h2>
        <Rows
          rows={report.byTemplate.map((row) => `${row.templateName}: ${row.runsStarted} runs`)}
        />
        <h2 className="text-lg font-semibold text-paper-100">By repository</h2>
        <Rows
          rows={report.byRepo.map(
            (row) =>
              `${row.repositoryName}: ${row.runsStarted} runs · $${row.spendUsd.toFixed(2)} spend`
          )}
        />
      </section>
    );
  }

  if (tab === 'quality') {
    const report = data as QualityReportData;
    const populated =
      report.gates.some((gate) => gate.total > 0) ||
      report.fixLoops.some((loop) => loop.runsWithFix > 0) ||
      report.review.byReviewer.some((reviewer) => reviewer.verdicts > 0);
    if (!populated) {
      return (
        <EmptyState
          hint="Gate and review results appear here when recorded."
          title="No quality data yet"
        />
      );
    }
    return (
      <section aria-label="Quality report" className="space-y-5">
        <Metric label="CI self-heal rate" value={percent(report.ciSelfHealRate)} />
        <h2 className="text-lg font-semibold text-paper-100">Quality gates</h2>
        <Rows
          rows={report.gates
            .filter((gate) => gate.total > 0)
            .map(
              (gate) =>
                `${gate.stepName}: ${gate.passed}/${gate.total} passed (${percent(gate.passRate)})`
            )}
        />
        <h2 className="text-lg font-semibold text-paper-100">Fix loops</h2>
        <Rows
          rows={report.fixLoops
            .filter((loop) => loop.runsWithFix > 0)
            .map(
              (loop) =>
                `${loop.stepName}: ${loop.totalRounds} rounds across ${loop.runsWithFix} runs`
            )}
        />
        <h2 className="text-lg font-semibold text-paper-100">Review network</h2>
        <Rows
          rows={report.review.byReviewer
            .filter((reviewer) => reviewer.verdicts > 0)
            .map(
              (reviewer) =>
                `${reviewer.reviewer}: ${reviewer.verdicts} verdicts · ${percent(reviewer.approvalRate)} approved · ${reviewer.findingsTotal} findings`
            )}
        />
      </section>
    );
  }

  if (tab === 'budget') {
    const report = data as BudgetReportData;
    if (report.organizations.length === 0) {
      return (
        <EmptyState
          hint="No organizations are in your budget-report scope."
          title="No budget data available"
        />
      );
    }
    return (
      <section aria-label="Budget report" className="space-y-4">
        <p className="text-sm text-paper-400">
          Budget status uses month-to-date spend, regardless of the selected date range.
        </p>
        <Rows
          rows={report.organizations.map(
            (org) =>
              `${org.name}: $${org.mtdUsd.toFixed(2)} MTD · $${org.projectedUsd.toFixed(2)} projected · ${org.status}${org.lowConfidence ? ' · low confidence' : ''}`
          )}
        />
        {report.organizations.flatMap((org) => org.topRuns).length > 0 && (
          <>
            <h2 className="text-lg font-semibold text-paper-100">Top runs this month</h2>
            <Rows
              rows={report.organizations.flatMap((org) =>
                org.topRuns.map(
                  (run) => `${org.name} · ${run.workflowId}: $${run.costUsd.toFixed(2)}`
                )
              )}
            />
          </>
        )}
      </section>
    );
  }

  if (tab === 'automations') {
    const report = data as AutomationReportData;
    if (report.automations.length === 0) {
      return (
        <EmptyState
          hint="Automation fires appear here when the selected period has activity."
          title="No automation activity yet"
        />
      );
    }
    return (
      <section aria-label="Automation report" className="space-y-3">
        <Rows
          rows={report.automations.map(
            (automation) =>
              `${automation.automationName}: ${automation.fires} fires · ${automation.started} started · ${automation.suppressed.total} suppressed (${percent(automation.suppressed.share)})${automation.noisy ? ' · noisy' : ''}${automation.broken ? ' · broken' : ''}`
          )}
        />
      </section>
    );
  }

  const report = data as HitlReportData;
  if (report.pendingNow === 0 && report.timedOut === 0 && report.byApprover.length === 0) {
    return (
      <EmptyState
        hint="Human-step and autonomy decisions appear here when recorded."
        title="No approval activity yet"
      />
    );
  }
  return (
    <section aria-label="Approvals report" className="space-y-5">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Pending now" value={report.pendingNow} />
        <Metric label="Timed out in period" value={report.timedOut} />
        <Metric label="Median resolution wait" value={duration(report.medianWaitMs)} />
        <Metric label="Oldest pending age" value={duration(report.oldestPendingAgeMs)} />
      </dl>
      <h2 className="text-lg font-semibold text-paper-100">By approver</h2>
      <Rows
        rows={report.byApprover.map(
          (approver) =>
            `${approver.name}: ${approver.resolved} resolved · ${duration(approver.medianWaitMs)} median wait`
        )}
      />
      <h2 className="text-lg font-semibold text-paper-100">Autonomy decisions</h2>
      <Rows
        rows={Object.entries(report.autonomy.byEvent).map(([event, count]) => `${event}: ${count}`)}
      />
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-ink-600 bg-ink-900/30 p-4">
      <dt className="text-xs text-paper-500">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-paper-100">{value}</dd>
    </div>
  );
}

function Rows({ rows }: { rows: string[] }) {
  return rows.length > 0 ? (
    <ul className="divide-y divide-ink-700 rounded-lg border border-ink-700">
      {rows.map((row) => (
        <li className="px-4 py-3 text-sm text-paper-200" key={row}>
          {row}
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-paper-500">No rows in this period.</p>
  );
}
