'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { OrgBudgetTable } from '@/components/govern/OrgBudgetTable';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useUserOrgs } from '@/hooks/useAdmin';
import { navLabel } from '@/lib/navigation';

export default function GovernOrganizationsPage() {
  const { data: orgs, isLoading, isError, error: loadError } = useUserOrgs();
  const router = useRouter();
  const params = useSearchParams();
  // The filter lives in the URL so the old Budget alerts link (`?alerting=1`) lands on it.
  const alertingOnly = params.get('alerting') === '1';

  const alertCount = (orgs ?? []).filter((o) => o.alert.triggered).length;
  const rows = alertingOnly ? (orgs ?? []).filter((o) => o.alert.triggered) : (orgs ?? []);

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Govern"
        subtitle="Organizations you belong to. Alerts fire when this month's spend crosses the configured threshold."
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
        isLoading={isLoading}
        label="organizations"
      >
        <Card>
          <CardHeader>
            <CardTitle>{alertingOnly ? 'Alerting organizations' : 'All organizations'}</CardTitle>
            <Checkbox
              checked={alertingOnly}
              label="Alerting only"
              onChange={(e) =>
                router.replace(
                  e.target.checked ? '/govern/organizations?alerting=1' : '/govern/organizations'
                )
              }
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
              columns={[
                'name',
                'slug',
                'role',
                'cap',
                'spent',
                'threshold',
                'percentUsed',
                'status',
              ]}
              rows={rows}
            />
          )}
        </Card>
      </QueryBoundary>
    </div>
  );
}
