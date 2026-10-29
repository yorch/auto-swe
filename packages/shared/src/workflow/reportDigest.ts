import { combineWorkflowRunRollupRows, type WorkflowRunRollupRow } from './workflowRunRollup.js';
import { deliveryReportFromRollups } from './workflowRunRollupReports.js';

export interface ReportDigestInput {
  budget?: { mtdUsd: number; projectedUsd: number; status: string };
  currentPeriod: { end: Date; start: Date };
  currentRows: readonly WorkflowRunRollupRow[];
  oldestPendingApprovalRequestedAt: Date | null;
  pendingApprovalCount: number;
  previousPeriod: { end: Date; start: Date };
  previousRows: readonly WorkflowRunRollupRow[];
  reportsUrl?: string;
  scope: { name: string; type: 'ORGANIZATION' | 'TEAM' };
  templateNames?: ReadonlyMap<string, string>;
  worstGate?: { finalPassRate: number; name: string; pairs: number };
  worstGateNotComputed?: boolean;
  now?: Date;
}

export interface ReportDigest {
  html: string;
  slackBlocks: unknown[];
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

function deltaPresentation(
  current: number | null,
  previous: number | null,
  percent: boolean,
  higherIsBetter: boolean
): { arrow: string; color: string; text: string } {
  if (current === null || previous === null) {
    return { arrow: '—', color: '#687386', text: 'n/a' };
  }
  const difference = current - previous;
  const arrow = difference > 0 ? '↑' : difference < 0 ? '↓' : '→';
  const color =
    difference === 0 ? '#687386' : difference > 0 === higherIsBetter ? '#18794e' : '#b42318';
  return { arrow, color, text: metricDelta(current, previous, percent) };
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
  const oldestApproval = input.oldestPendingApprovalRequestedAt;
  const oldestAgeHours =
    oldestApproval === null
      ? null
      : Math.max(0, (now.getTime() - oldestApproval.getTime()) / (60 * 60 * 1000));
  const scopeName = input.scope.name.replace(/[\r\n]+/g, ' ').trim();
  const subject = `${scopeName} weekly report — ${periodLabel(input.currentPeriod)}`;
  const metrics = [
    {
      current: current.runs,
      format: (value: number) => String(value),
      higherIsBetter: true,
      label: 'Runs',
      percent: false,
      previous: previous.runs,
    },
    {
      current: current.successRate,
      format: (value: number) => `${(value * 100).toFixed(1)}%`,
      higherIsBetter: true,
      label: 'Success rate',
      percent: true,
      previous: previous.successRate,
    },
    {
      current: current.prsMerged,
      format: (value: number) => String(value),
      higherIsBetter: true,
      label: 'PRs merged',
      percent: false,
      previous: previous.prsMerged,
    },
    {
      current: current.costPerMergedPr,
      format: (value: number) => `$${value.toFixed(2)}`,
      higherIsBetter: false,
      label: 'Cost per merged PR',
      percent: false,
      previous: previous.costPerMergedPr,
    },
    {
      current: current.spendUsd,
      format: (value: number) => `$${value.toFixed(2)}`,
      higherIsBetter: false,
      label: 'Spend',
      percent: false,
      previous: previous.spendUsd,
    },
    {
      current: current.estimatedTimeSavedMinutes,
      format: (value: number) => `${value.toFixed(0)} min`,
      higherIsBetter: true,
      label: 'Estimated time saved',
      percent: false,
      previous: previous.estimatedTimeSavedMinutes,
    },
  ] as const;
  const lines = [
    `${input.scope.type === 'TEAM' ? 'Team' : 'Organization'}: ${scopeName}`,
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
    ...(input.worstGateNotComputed ? ['Worst gate: not computed'] : []),
    `Pending approvals: ${input.pendingApprovalCount}${oldestAgeHours === null ? '' : `; oldest ${oldestAgeHours.toFixed(1)} hours`}`,
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
  const metricsHtml = metrics
    .map((metric) => {
      const delta = deltaPresentation(
        metric.current,
        metric.previous,
        metric.percent,
        metric.higherIsBetter
      );
      const value = metric.current === null ? 'n/a' : metric.format(metric.current);
      return `<tr><td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#344054">${escapeHtml(metric.label)}</td><td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;color:#101828">${escapeHtml(value)}</td><td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;color:${delta.color}">${delta.arrow} ${escapeHtml(delta.text)}</td></tr>`;
    })
    .join('');
  const runsByDay = new Map<string, number>();
  for (const row of input.currentRows) {
    const key = row.day.toISOString().slice(0, 10);
    runsByDay.set(key, (runsByDay.get(key) ?? 0) + row.runs);
  }
  const dailyRuns = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(input.currentPeriod.start.getTime() + index * 24 * 60 * 60 * 1000);
    const key = date.toISOString().slice(0, 10);
    return { count: runsByDay.get(key) ?? 0, date: key };
  });
  const maxDailyRuns = Math.max(1, ...dailyRuns.map(({ count }) => count));
  const chartHtml = dailyRuns
    .map(({ count, date }) => {
      const width = count === 0 ? 0 : Math.max(4, Math.round((count / maxDailyRuns) * 100));
      return `<tr><td style="padding:5px 10px;color:#475467;white-space:nowrap">${date}</td><td style="padding:5px 10px;width:100%"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td width="${width}%" style="height:16px;background-color:#2563eb;font-size:1px;line-height:1px">&nbsp;</td><td style="font-size:12px;padding-left:8px;color:#344054">${count}</td></tr></table></td></tr>`;
    })
    .join('');
  const rateBar = (rate: number | null, color: string) => {
    if (rate === null) {
      return '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="color:#687386">n/a</td></tr></table>';
    }
    const width = Math.max(0, Math.min(100, Math.round(rate * 100)));
    return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding-right:8px;white-space:nowrap">${(rate * 100).toFixed(1)}%</td><td width="100%"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td width="${width}%" style="height:8px;background-color:${color};font-size:1px;line-height:1px">&nbsp;</td><td></td></tr></table></td></tr></table>`;
  };
  const templateRowsHtml = topTemplates.length
    ? topTemplates
        .map(
          (template) =>
            `<tr><td style="padding:10px;border-bottom:1px solid #e5e7eb">${escapeHtml(template.name)}</td><td style="padding:10px;border-bottom:1px solid #e5e7eb">${template.runs}</td><td style="padding:10px;border-bottom:1px solid #e5e7eb">${rateBar(template.successRate, '#18794e')}</td><td style="padding:10px;border-bottom:1px solid #e5e7eb">${rateBar(template.mergeRate, '#2563eb')}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="4" style="padding:10px;color:#687386">No template runs</td></tr>';
  const additionalLines = [
    input.worstGate && input.worstGate.pairs >= 10
      ? `Worst gate: ${input.worstGate.name} (${(input.worstGate.finalPassRate * 100).toFixed(1)}% final pass rate)`
      : input.worstGateNotComputed
        ? 'Worst gate: not computed'
        : null,
    `Pending approvals: ${input.pendingApprovalCount}${oldestAgeHours === null ? '' : `; oldest ${oldestAgeHours.toFixed(1)} hours`}`,
    ...(input.budget
      ? [
          `Budget: ${input.budget.status}`,
          `Month-to-date spend: $${input.budget.mtdUsd.toFixed(2)}`,
          `Projected monthly spend: $${input.budget.projectedUsd.toFixed(2)}`,
        ]
      : []),
  ].filter((line): line is string => line !== null);
  const additionalHtml = additionalLines
    .map((line) => `<tr><td style="padding:3px 0">${escapeHtml(line)}</td></tr>`)
    .join('');
  const html = `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-family:Arial,sans-serif;color:#101828;max-width:720px"><tr><td style="padding:20px 0;font-size:24px;font-weight:700">${escapeHtml(scopeName)} weekly report</td></tr><tr><td style="padding:0 0 16px;color:#475467">${escapeHtml(periodLabel(input.currentPeriod))} (previous: ${escapeHtml(periodLabel(input.previousPeriod))})</td></tr><tr><td style="padding:0 0 8px;font-size:18px;font-weight:600">Metrics</td></tr><tr><td><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse"><tr><th align="left" style="padding:10px;background:#f2f4f7">Metric</th><th align="right" style="padding:10px;background:#f2f4f7">This week</th><th align="right" style="padding:10px;background:#f2f4f7">Δ</th></tr>${metricsHtml}</table></td></tr><tr><td style="padding:22px 0 8px;font-size:18px;font-weight:600">Runs by day</td></tr><tr><td><table role="presentation" cellpadding="0" cellspacing="0" width="100%">${chartHtml}</table></td></tr><tr><td style="padding:22px 0 8px;font-size:18px;font-weight:600">Top templates</td></tr><tr><td><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse"><tr><th align="left" style="padding:10px;background:#f2f4f7">Template</th><th align="left" style="padding:10px;background:#f2f4f7">Runs</th><th align="left" style="padding:10px;background:#f2f4f7">Success rate</th><th align="left" style="padding:10px;background:#f2f4f7">Merge rate</th></tr>${templateRowsHtml}</table></td></tr><tr><td style="padding:18px 0"><table role="presentation" cellpadding="0" cellspacing="0" width="100%">${additionalHtml}</table></td></tr><tr><td style="padding:8px 0 20px"><a href="${escapeHtml(input.reportsUrl ?? '/admin/reports')}" style="color:#175cd3">Open reports</a></td></tr></table>`;
  const slackFields = metrics.map((metric) => {
    const delta = deltaPresentation(
      metric.current,
      metric.previous,
      metric.percent,
      metric.higherIsBetter
    );
    const value = metric.current === null ? 'n/a' : metric.format(metric.current);
    return {
      text: `*${escapeSlack(metric.label)}*\n${escapeSlack(value)} (${delta.arrow} ${escapeSlack(delta.text)})`,
      type: 'mrkdwn',
    };
  });
  const slackBlocks = [
    {
      text: { text: `${escapeSlack(scopeName)} weekly report`, type: 'plain_text' },
      type: 'header',
    },
    { fields: slackFields, type: 'section' },
    { text: { text: escapeSlack(additionalLines.join(' · ')), type: 'mrkdwn' }, type: 'section' },
    {
      elements: [
        {
          text: `Period: ${escapeSlack(periodLabel(input.currentPeriod))}`,
          type: 'mrkdwn',
        },
      ],
      type: 'context',
    },
    {
      elements: [
        {
          action_id: 'open_report_digest',
          text: { text: 'Open reports', type: 'plain_text' },
          type: 'button',
          url: input.reportsUrl ?? '/admin/reports',
        },
      ],
      type: 'actions',
    },
  ];
  return { html, slackBlocks, slackMrkdwn, subject, text };
}
