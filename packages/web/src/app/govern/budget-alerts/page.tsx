'use client';

import { OrgBudgetTable } from '@/components/govern/OrgBudgetTable';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useBudgetAlerts } from '@/hooks/useOrg';

export default function BudgetAlertsPage() {
  const { data: orgs, isLoading, isError, error: loadError } = useBudgetAlerts();
  const alerting = (orgs ?? []).filter((o) => o.alert.triggered);

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Govern"
        subtitle="Organizations whose current month spend has crossed their configured alert threshold."
        title="Budget alerts"
      />

      {alerting.length > 0 && (
        <Alert variant="warning">
          {alerting.length} organization{alerting.length === 1 ? '' : 's'} above threshold.
        </Alert>
      )}

      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="budget alerts"
      >
        {
          <Card>
            <CardHeader>
              <CardTitle>Alerting organizations</CardTitle>
            </CardHeader>
            {alerting.length === 0 ? (
              <EmptyState title="No organizations above their alert threshold." />
            ) : (
              <OrgBudgetTable
                columns={['name', 'cap', 'spent', 'threshold', 'percentUsed', 'status']}
                nameLabel="Organization"
                rows={alerting}
              />
            )}
          </Card>
        }
      </QueryBoundary>
    </div>
  );
}
