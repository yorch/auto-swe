'use client';

import { useState } from 'react';
import { OrgBudgetTable } from '@/components/govern/OrgBudgetTable';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { useOrganizationDirectory } from '@/hooks/useAdmin';
import { useHasRole } from '@/hooks/useHasRole';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { navLabel } from '@/lib/navigation';
import { plural } from '@/lib/utils';

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
  const [search, setSearch] = useState('');

  const all = orgs ?? [];
  const alertCount = all.filter((o) => o.alert.triggered).length;
  const query = search.trim().toLowerCase();
  const rows = all.filter(
    (o) =>
      (!alertingOnly || o.alert.triggered) &&
      (!query || o.name.toLowerCase().includes(query) || o.slug.toLowerCase().includes(query))
  );
  const filtering = alertingOnly || query !== '';
  const clearFilters = () => {
    setSearch('');
    update({ alerting: null });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="Every organization on the platform for admins, otherwise the ones you belong to. Alerts fire when this month's spend crosses the configured threshold."
        title={navLabel('/govern/organizations')}
      />

      {alertCount > 0 && (
        <Alert
          action={
            !alertingOnly && (
              <Button onClick={() => update({ alerting: '1' })} size="sm">
                Show them
              </Button>
            )
          }
          variant="warning"
        >
          {plural(alertCount, 'organization')} above the monthly budget alert threshold.
        </Alert>
      )}

      <Card className="p-4 sm:p-6">
        <Toolbar
          end={
            all.length > 0 && (
              <span className="text-xs text-paper-500 tabular-nums">
                {filtering
                  ? `${rows.length} of ${plural(all.length, 'organization')}`
                  : plural(all.length, 'organization')}
              </span>
            )
          }
        >
          <SearchInput
            label="Search organizations"
            onChange={setSearch}
            placeholder="Search name or slug…"
            value={search}
          />
          <Checkbox
            checked={alertingOnly}
            label="Alerting only"
            onChange={(e) => update({ alerting: e.target.checked ? '1' : null })}
          />
        </Toolbar>
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={false}
          label="organizations"
          onRetry={() => void refetch()}
        >
          {isLoading ? (
            <SkeletonRows rows={4} />
          ) : rows.length === 0 ? (
            filtering && all.length > 0 ? (
              <EmptyState
                action={
                  <Button onClick={clearFilters} size="sm">
                    Clear filters
                  </Button>
                }
                hint={
                  alertingOnly && !query
                    ? 'Every organization is under its alert threshold.'
                    : 'Try a different search.'
                }
                icon={alertingOnly && !query ? 'checkCircle' : 'search'}
                title={
                  alertingOnly && !query
                    ? 'No organizations are above their alert threshold'
                    : 'No organizations match these filters'
                }
              />
            ) : (
              <EmptyState
                hint={
                  isAdmin
                    ? 'Organizations group teams under a shared monthly budget and membership.'
                    : 'You are not a member of any organization yet.'
                }
                icon="building"
                title="No organizations yet"
              />
            )
          ) : (
            <OrgBudgetTable
              columns={(
                ['name', 'role', 'cap', 'spent', 'threshold', 'percentUsed', 'status'] as const
              ).filter((c) => (isAdmin ? c !== 'role' : true))}
              rows={rows}
            />
          )}
        </QueryBoundary>
      </Card>
    </div>
  );
}
