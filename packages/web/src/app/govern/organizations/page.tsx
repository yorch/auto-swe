'use client';

import { OrgBudgetTable } from '@/components/govern/OrgBudgetTable';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useOrganizationDirectory } from '@/hooks/useAdmin';
import { useHasRole } from '@/hooks/useHasRole';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { navLabel } from '@/lib/navigation';

export default function GovernOrganizationsPage() {
  const {
    data: orgs,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useOrganizationDirectory();
  const isAdmin = useHasRole('ADMIN');
  const { params, update } = useUrlFilters();
  // The filter lives in the URL so the old Budget alerts link (`?alerting=1`) lands on it.
  const alertingOnly = params.get('alerting') === '1';

  const alertCount = (orgs ?? []).filter((o) => o.alert.triggered).length;
  const rows = alertingOnly ? (orgs ?? []).filter((o) => o.alert.triggered) : (orgs ?? []);

  return (
    <div className="space-y-8">
      <PageHeader
        subtitle="Every organization on the platform for admins, otherwise the ones you belong to. Alerts fire when this month's spend crosses the configured threshold."
        title={navLabel('/govern/organizations')}
      />

      {alertCount > 0 && (
        <Alert variant="warning">
          {alertCount} organization{alertCount === 1 ? '' : 's'} above the monthly budget alert
          threshold.
        </Alert>
      )}

      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="organizations"
        onRetry={() => void refetch()}
      >
        <Card>
          <CardHeader>
            <CardTitle>{alertingOnly ? 'Alerting organizations' : 'All organizations'}</CardTitle>
            <Checkbox
              checked={alertingOnly}
              label="Alerting only"
              onChange={(e) => update({ alerting: e.target.checked ? '1' : null })}
            />
          </CardHeader>
          {rows.length === 0 ? (
            <EmptyState
              title={
                alertingOnly
                  ? 'No organizations are above their alert threshold.'
                  : 'No organizations found.'
              }
            />
          ) : (
            <OrgBudgetTable
              columns={(
                [
                  'name',
                  'slug',
                  'role',
                  'cap',
                  'spent',
                  'threshold',
                  'percentUsed',
                  'status',
                ] as const
              ).filter((c) => (isAdmin ? c !== 'role' : true))}
              rows={rows}
            />
          )}
        </Card>
      </QueryBoundary>
    </div>
  );
}
