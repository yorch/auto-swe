import { combineWorkflowRunRollupRows, type WorkflowRunRollupRow } from './workflowRunRollup.js';
import { deliveryReportFromRollups } from './workflowRunRollupReports.js';

export interface ReportDigestInput {
  budget?: { mtdUsd: number; projectedUsd: number; status: string };
  currentPeriod: { end: Date; start: Date };
  currentRows: readonly WorkflowRunRollupRow[];
  pendingApprovals: readonly { requestedAt: Date }[];
  previousPeriod: { end: Date; start: Date };
  previousRows: readonly WorkflowRunRollupRow[];
  reportsUrl?: string;
  scope: { name: string; type: 'ORGANIZATION' | 'TEAM' };
  templateNames?: ReadonlyMap<string, string>;
  worstGate?: { finalPassRate: number; name: string; pairs: number };
  now?: Date;
}

export interface ReportDigest {
  html: string;
  slackMrkdwn: string;
  subject: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "'": '&#39;',
      '"': '&quot;',
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
    };
    return entities[char] ?? char;
  });
}

function escapeSlack(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\*_~`|]/g, '\\$&');
}

function summarize(rows: readonly WorkflowRunRollupRow[]) {
  const totals = combineWorkflowRunRollupRows(rows);
  const delivery = deliveryReportFromRollups(rows);
  return {
    costPerMergedPr: delivery.costPerMergedPr,
    estimatedTimeSavedMinutes: totals.timeSavedMinutes,
    prsMerged: delivery.prsMerged,
    runs: delivery.runsStarted,
    spendUsd: delivery.spendUsd,
    successRate: delivery.successRate,
  };
}

function metricDelta(current: number | null, previous: number | null, percent = false): string {
  if (current === null || previous === null) {
    return 'n/a';
  }
  const difference = current - previous;
  const formatted = percent
    ? `${(difference * 100).toFixed(1)} pp`
    : difference.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return `${difference > 0 ? '+' : ''}${formatted}`;
}

function periodLabel(period: { end: Date; start: Date }): string {
  return `${period.start.toISOString().slice(0, 10)} – ${period.end.toISOString().slice(0, 10)}`;
}

export function buildReportDigest(input: ReportDigestInput): ReportDigest {
  const current = summarize(input.currentRows);
  const previous = summarize(input.previousRows);
  const byTemplate = new Map<string, WorkflowRunRollupRow[]>();
  for (const row of input.currentRows) {
    if (!row.templateId) {
      continue;
    }
    const templateRows = byTemplate.get(row.templateId) ?? [];
    templateRows.push(row);
    byTemplate.set(row.templateId, templateRows);
  }
  const topTemplates = [...byTemplate.entries()]
    .map(([id, rows]) => {
      const metrics = summarize(rows);
      const totals = combineWorkflowRunRollupRows(rows);
      const mergeDecided = totals.prsMerged + totals.prsClosedUnmerged;
      return {
        mergeRate: mergeDecided > 0 ? totals.prsMerged / mergeDecided : null,
        name: input.templateNames?.get(id) ?? id,
        runs: metrics.runs,
        successRate: metrics.successRate,
      };
    })
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name))
    .slice(0, 3);
  const now = input.now ?? new Date();
  const oldestApproval = input.pendingApprovals.reduce<Date | null>(
    (oldest, approval) =>
      oldest === null || approval.requestedAt < oldest ? approval.requestedAt : oldest,
    null
  );
  const oldestAgeHours =
    oldestApproval === null
      ? null
      : Math.max(0, (now.getTime() - oldestApproval.getTime()) / (60 * 60 * 1000));
  const subject = `${input.scope.name} weekly report — ${periodLabel(input.currentPeriod)}`;
  const lines = [
    `${input.scope.type === 'TEAM' ? 'Team' : 'Organization'}: ${input.scope.name}`,
    `Period: ${periodLabel(input.currentPeriod)} (previous: ${periodLabel(input.previousPeriod)})`,
    `Runs: ${current.runs} (${metricDelta(current.runs, previous.runs)})`,
    `Success rate: ${current.successRate === null ? 'n/a' : `${(current.successRate * 100).toFixed(1)}%`} (${metricDelta(current.successRate, previous.successRate, true)})`,
    `PRs merged: ${current.prsMerged} (${metricDelta(current.prsMerged, previous.prsMerged)})`,
    `Cost per merged PR: ${current.costPerMergedPr === null ? 'n/a' : `$${current.costPerMergedPr.toFixed(2)}`} (${metricDelta(current.costPerMergedPr, previous.costPerMergedPr)})`,
    `Spend: $${current.spendUsd.toFixed(2)} (${metricDelta(current.spendUsd, previous.spendUsd)})`,
    `Estimated time saved: ${current.estimatedTimeSavedMinutes.toFixed(0)} min (${metricDelta(current.estimatedTimeSavedMinutes, previous.estimatedTimeSavedMinutes)})`,
    '',
    'Top templates:',
    ...(topTemplates.length
      ? topTemplates.map(
          (template) =>
            `- ${template.name}: ${template.runs} runs, ${template.successRate === null ? 'n/a' : `${(template.successRate * 100).toFixed(1)}%`} success, ${template.mergeRate === null ? 'n/a' : `${(template.mergeRate * 100).toFixed(1)}%`} merge`
        )
      : ['- No template runs']),
    '',
    ...(input.worstGate && input.worstGate.pairs >= 10
      ? [
          `Worst gate: ${input.worstGate.name} (${(input.worstGate.finalPassRate * 100).toFixed(1)}% final pass rate)`,
        ]
      : []),
    `Pending approvals: ${input.pendingApprovals.length}${oldestAgeHours === null ? '' : `; oldest ${oldestAgeHours.toFixed(1)} hours`}`,
    ...(input.budget
      ? [
          `Budget: ${input.budget.status}`,
          `Month-to-date spend: $${input.budget.mtdUsd.toFixed(2)}`,
          `Projected monthly spend: $${input.budget.projectedUsd.toFixed(2)}`,
        ]
      : []),
    `Open reports: ${input.reportsUrl ?? '/admin/reports'}`,
  ];
  const text = lines.join('\n');
  const slackMrkdwn = lines.map((line) => escapeSlack(line)).join('\n');
  const html = `<h1>${escapeHtml(input.scope.name)} weekly report</h1><p>${escapeHtml(periodLabel(input.currentPeriod))} (previous: ${escapeHtml(periodLabel(input.previousPeriod))})</p><ul>${lines
    .filter((line) => line && !line.startsWith('Top templates:'))
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('')}</ul><h2>Top templates</h2><ul>${topTemplates
    .map(
      (template) =>
        `<li>${escapeHtml(template.name)}: ${template.runs} runs, ${template.successRate === null ? 'n/a' : `${(template.successRate * 100).toFixed(1)}%`} success, ${template.mergeRate === null ? 'n/a' : `${(template.mergeRate * 100).toFixed(1)}%`} merge</li>`
    )
    .join(
      ''
    )}</ul><p><a href="${escapeHtml(input.reportsUrl ?? '/admin/reports')}">Open reports</a></p>`;
  return { html, slackMrkdwn, subject, text };
}
