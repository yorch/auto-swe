import type { ReportTab, ReportTabData } from './ReportTabPanel';

function csvCell(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `"${String(value)}"`;
  }
  const rawText =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  const text = /^[=+\-@\t\r]/.test(rawText) ? `'${rawText}` : rawText;
  return `"${text.replaceAll('"', '""')}"`;
}

function sectionRows(section: string, rows: Array<Record<string, unknown>>) {
  return rows.map((row) => ({ section, ...row }));
}

function rowsFor(tab: ReportTab, data: ReportTabData): Array<Record<string, unknown>> {
  if (tab === 'delivery') {
    const report = data as Extract<ReportTabData, { byTemplate: unknown[] }>;
    const { byRepo, byTeam, byTemplate, ...summary } = report;
    return [
      ...sectionRows('summary', [summary]),
      ...sectionRows('byTemplate', byTemplate as Array<Record<string, unknown>>),
      ...sectionRows('byRepo', byRepo as Array<Record<string, unknown>>),
      ...sectionRows('byTeam', byTeam as Array<Record<string, unknown>>),
    ];
  }
  if (tab === 'quality') {
    const report = data as Extract<ReportTabData, { gates: unknown[] }>;
    return [
      ...sectionRows('gates', report.gates as Array<Record<string, unknown>>),
      ...sectionRows('fixLoops', report.fixLoops as Array<Record<string, unknown>>),
      ...sectionRows('reviewers', report.review.byReviewer as Array<Record<string, unknown>>),
      ...sectionRows(
        'mergeByReviewOutcome',
        Object.entries(report.mergeRateByReviewOutcome).map(([reviewOutcome, metrics]) => ({
          reviewOutcome,
          ...(metrics as Record<string, unknown>),
        }))
      ),
    ];
  }
  if (tab === 'budget') {
    const organizations = (data as Extract<ReportTabData, { organizations: unknown[] }>)
      .organizations;
    return [
      ...sectionRows(
        'organizations',
        organizations.map(({ topRuns, ...organization }) => organization)
      ),
      ...sectionRows(
        'topRuns',
        organizations.flatMap((organization) =>
          organization.topRuns.map((run) => ({
            organizationName: organization.name,
            orgId: organization.orgId,
            ...run,
          }))
        )
      ),
    ];
  }
  if (tab === 'automations') {
    return sectionRows(
      'automations',
      (data as Extract<ReportTabData, { automations: unknown[] }>).automations as Array<
        Record<string, unknown>
      >
    );
  }
  const report = data as Extract<ReportTabData, { byApprover: unknown[] }>;
  const { autonomy, byApprover, byKind, byVia, ...summary } = report;
  return [
    ...sectionRows('summary', [summary]),
    ...sectionRows(
      'byKind',
      Object.entries(byKind).flatMap(([kind, counts]) =>
        Object.entries(counts).map(([status, count]) => ({ count, kind, status }))
      )
    ),
    ...sectionRows('approvers', report.byApprover as Array<Record<string, unknown>>),
    ...sectionRows(
      'byVia',
      Object.entries(byVia).map(([via, count]) => ({ count, via }))
    ),
    ...sectionRows(
      'autonomyByEvent',
      Object.entries(autonomy.byEvent).map(([event, count]) => ({ count, event }))
    ),
    ...sectionRows(
      'autonomyByRisk',
      Object.entries(autonomy.byRiskClass).map(([riskClass, count]) => ({
        count,
        riskClass,
      }))
    ),
  ];
}

export function reportCsv(tab: ReportTab, data: ReportTabData): string {
  const rows = rowsFor(tab, data);
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0) {
    return '';
  }
  return [
    columns.map(csvCell).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
  ].join('\r\n');
}
