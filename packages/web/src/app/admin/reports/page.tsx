'use client';

import { useQuery } from '@tanstack/react-query';
import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { DateRangeControl } from '@/components/ui/DateRangeControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { ApiError, api } from '@/lib/api';
import {
  customRangeIgnored,
  dateRangePatch,
  parseDateRange,
  rangeKey,
  rangeQuery,
} from '@/lib/dateRange';
import { type ReportTab, type ReportTabData, ReportTabPanel } from './ReportTabPanel';
import { reportCsv } from './reportCsv';

const TABS: Array<{ id: ReportTab; label: string; filename: string }> = [
  { filename: 'delivery-report.csv', id: 'delivery', label: 'Delivery' },
  { filename: 'quality-report.csv', id: 'quality', label: 'Quality' },
  { filename: 'budget-report.csv', id: 'budget', label: 'Budget' },
  { filename: 'automations-report.csv', id: 'automations', label: 'Automations' },
  { filename: 'approvals-report.csv', id: 'hitl', label: 'Approvals' },
];

function selectedTab(value: string | null): ReportTab {
  return TABS.some((tab) => tab.id === value) ? (value as ReportTab) : 'delivery';
}

function ReportsWorkspace() {
  const { params, update } = useUrlFilters();
  const range = parseDateRange(params);
  const [localTab, setLocalTab] = useState<ReportTab>('delivery');
  const activeTab = selectedTab(params.get('tab') ?? localTab);
  const activeDefinition = TABS.find((tab) => tab.id === activeTab) ?? TABS[0];
  const query = new URLSearchParams(rangeQuery(range));
  const reportQuery = useQuery({
    queryFn: () =>
      api
        .get<{ data: ReportTabData }>(`/api/v1/reports/${activeTab}?${query}`)
        .then((response) => response.data),
    queryKey: ['reports', activeTab, rangeKey(range)],
    refetchInterval: 30_000,
  });

  function exportCsv() {
    if (!reportQuery.data) {
      return;
    }
    const contents = reportCsv(activeTab, reportQuery.data);
    const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = activeDefinition.filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!reportQuery.data} onClick={exportCsv} size="sm" variant="secondary">
              Export CSV
            </Button>
            <DateRangeControl
              onChange={(next) => next && update(dateRangePatch(next))}
              rangeIgnored={customRangeIgnored(params)}
              value={range}
            />
          </div>
        }
        learnMore={{ slug: 'reporting' }}
        subtitle="Delivery, quality, budget, automation, and approval outcomes across workflow runs."
        title="Reports"
      />
      <div aria-label="Report tabs" className="flex flex-wrap gap-2" role="tablist">
        {TABS.map((tab) => (
          <button
            aria-selected={activeTab === tab.id}
            className={`rounded-md px-3 py-2 text-sm ${activeTab === tab.id ? 'bg-accent-500 text-paper-50' : 'border border-ink-600 text-paper-300'}`}
            key={tab.id}
            onClick={() => {
              setLocalTab(tab.id);
              update({ tab: tab.id === 'delivery' ? null : tab.id });
            }}
            role="tab"
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === 'budget' &&
      reportQuery.error instanceof ApiError &&
      reportQuery.error.status === 403 ? (
        <EmptyState
          hint="An organization administrator can grant access to budget forecasts."
          title="Budget forecasts need org admin access"
        />
      ) : (
        <QueryBoundary
          error={reportQuery.error}
          isError={reportQuery.isError}
          isFetching={reportQuery.isFetching}
          isLoading={reportQuery.isLoading}
          label={`${activeDefinition.label.toLowerCase()} report`}
          onRetry={() => void reportQuery.refetch()}
          rows={3}
          shape="cards"
        >
          {reportQuery.data && <ReportTabPanel data={reportQuery.data} tab={activeTab} />}
        </QueryBoundary>
      )}
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={null}>
      <ReportsWorkspace />
    </Suspense>
  );
}
