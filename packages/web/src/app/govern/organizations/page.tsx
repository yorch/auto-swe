'use client';

import { OrgBudgetTable } from '@/components/govern/OrgBudgetTable';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useUserOrgs } from '@/hooks/useAdmin';
import { navLabel } from '@/lib/navigation';

export default function GovernOrganizationsPage() {
  const { data: orgs, isLoading, isError, error: loadError } = useUserOrgs();

  const alertCount = (orgs ?? []).filter((o) => o.alert.triggered).length;

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Govern"
        subtitle="Organizations you belong to. Alerts fire when current month spend crosses the configured threshold."
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
        {
          <Card>
            <CardHeader>
              <CardTitle>All organizations</CardTitle>
            </CardHeader>
            {(orgs ?? []).length === 0 ? (
              <EmptyState title="No organizations found." />
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
                rows={orgs ?? []}
              />
            )}
          </Card>
        }
      </QueryBoundary>
    </div>
  );
}
