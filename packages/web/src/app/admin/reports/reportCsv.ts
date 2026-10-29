import type { ReportTab, ReportTabData } from './ReportTabPanel';

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function rowsFor(tab: ReportTab, data: ReportTabData): Array<Record<string, unknown>> {
  if (tab === 'delivery') {
    const report = data as Extract<ReportTabData, { byTemplate: unknown[] }>;
    return [
      ...report.byTemplate.map((row) => ({ slice: 'template', ...row })),
      ...report.byRepo.map((row) => ({ slice: 'repository', ...row })),
    ];
  }
  if (tab === 'quality') {
    return (data as Extract<ReportTabData, { gates: unknown[] }>).gates;
  }
  if (tab === 'budget') {
    return (data as Extract<ReportTabData, { organizations: unknown[] }>).organizations;
  }
  if (tab === 'automations') {
    return (data as Extract<ReportTabData, { automations: unknown[] }>).automations;
  }
  return (data as Extract<ReportTabData, { byApprover: unknown[] }>).byApprover;
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
