'use client';

import { useQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { Button } from '@/components/ui/Button';
import { DateRangeControl } from '@/components/ui/DateRangeControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { useTeams } from '@/hooks/useTeams';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { ApiError, api } from '@/lib/api';
import {
  customRangeIgnored,
  dateRangePatch,
  parseDateRange,
  rangeKey,
  rangeQuery,
} from '@/lib/dateRange';
import { HELP_LINKS } from '@/lib/helpLinks';
import { DigestsTab } from './DigestsTab';
import { type ReportTab, type ReportTabData, ReportTabPanel } from './ReportTabPanel';
import { reportCsv } from './reportCsv';

type TabId = ReportTab | 'digests';

const TABS: Array<{ id: TabId; label: string; filename: string }> = [
  { filename: 'delivery-report.csv', id: 'delivery', label: 'Delivery' },
  { filename: 'quality-report.csv', id: 'quality', label: 'Quality' },
  { filename: 'budget-report.csv', id: 'budget', label: 'Budget' },
  { filename: 'automations-report.csv', id: 'automations', label: 'Automations' },
  { filename: 'approvals-report.csv', id: 'hitl', label: 'Approvals' },
  { filename: '', id: 'digests', label: 'Digests' },
];

function selectedTab(value: string | null): TabId {
  return TABS.some((tab) => tab.id === value) ? (value as TabId) : 'delivery';
}

function ReportsWorkspace() {
  const { params, update } = useUrlFilters();
  const teamsQuery = useTeams();
  const range = parseDateRange(params);
  // The URL is the only source of the active tab, so Back and Forward show the tab they name.
  const activeTab = selectedTab(params.get('tab'));
  const activeDefinition = TABS.find((tab) => tab.id === activeTab) ?? TABS[0];
  const query = new URLSearchParams(rangeQuery(range));
  const teamId = params.get('teamId') ?? '';
  if (teamId) {
    query.set('teamId', teamId);
  }
  const reportQuery = useQuery({
    enabled: activeTab !== 'digests',
    queryFn: () =>
      api
        .get<{ data: ReportTabData }>(`/api/v1/reports/${activeTab}?${query}`)
        .then((response) => response.data),
    queryKey: ['reports', activeTab, rangeKey(range), teamId],
    refetchInterval: 30_000,
  });

  function exportCsv() {
    if (!reportQuery.data) {
      return;
    }
    if (activeTab === 'digests') {
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
            {activeTab !== 'digests' && (
              <Button
                disabled={!reportQuery.data}
                onClick={exportCsv}
                size="sm"
                variant="secondary"
              >
                Export CSV
              </Button>
            )}
            {activeTab !== 'digests' && (
              <DateRangeControl
                onChange={(next) => next && update(dateRangePatch(next))}
                rangeIgnored={customRangeIgnored(params)}
                value={range}
              />
            )}
            {activeTab !== 'budget' && activeTab !== 'digests' && (
              <div>
                <Select
                  appearance="pill"
                  aria-label="Team"
                  onChange={(value) => update({ teamId: value || null })}
                  options={[
                    { label: 'All visible teams', value: '' },
                    ...(teamsQuery.data ?? []).map((team) => ({
                      label: team.name,
                      value: team.id,
                    })),
                  ]}
                  prefix="Team:"
                  value={teamId}
                />
              </div>
            )}
          </div>
        }
        learnMore={{ ...HELP_LINKS.reporting }}
        subtitle="Delivery, quality, budget, automation, approval outcomes, and weekly digests."
        title="Reports"
      />
      <TabBar
        active={activeTab}
        ariaLabel="Report tabs"
        idPrefix="reports"
        onChange={(tab) => update({ tab: tab === 'delivery' ? null : tab })}
        tabs={TABS.map(({ id, label }) => ({ id, label }))}
      />
      <div {...tabPanelProps('reports', activeTab)}>
        {activeTab === 'digests' ? (
          <DigestsTab />
        ) : activeTab === 'budget' &&
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
