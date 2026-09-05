'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useBudgetAlerts } from '@/hooks/useOrg';

function fmtCents(n: number | null): string {
  if (n == null) {
    return 'No cap';
  }
  return `$${(n / 100).toFixed(2)}`;
}

export default function BudgetAlertsPage() {
  const { data: orgs, isLoading, isError, error: loadError } = useBudgetAlerts();
  const alerting = (orgs ?? []).filter((o) => o.alert.triggered);

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="Organizations whose current month spend has crossed their configured alert threshold."
        title="Budget Alerts"
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
            {(orgs ?? []).length === 0 ? (
              <EmptyState className="px-4 pt-0 pb-4 text-left" title="No organizations found." />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <THead className="text-left text-xs text-paper-400">
                    <Th variant="dense">Organization</Th>
                    <Th align="right" variant="dense">
                      Monthly cap
                    </Th>
                    <Th align="right" variant="dense">
                      Spent
                    </Th>
                    <Th align="right" variant="dense">
                      Threshold
                    </Th>
                    <Th align="right" variant="dense">
                      % used
                    </Th>
                    <Th align="center" variant="dense">
                      Status
                    </Th>
                  </THead>
                  <tbody>
                    {(orgs ?? [])
                      .filter((o) => o.alert.triggered)
                      .map((org) => (
                        <TRow key={org.id}>
                          <Td className="px-4 py-2">
                            <Link
                              className="text-ember-400 hover:underline"
                              href={`/admin/organizations/${org.id}`}
                            >
                              {org.name}
                            </Link>
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums">
                            {fmtCents(org.monthlyBudgetUsdCents)}
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums">
                            {org.currentMonthUsage
                              ? `$${org.currentMonthUsage.costUsdAccrued.toFixed(2)}`
                              : '$0.00'}
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums">
                            {org.budgetAlertThresholdPercent != null
                              ? `${org.budgetAlertThresholdPercent}%`
                              : '—'}
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums">
                            {org.alert.percent != null ? `${org.alert.percent.toFixed(1)}%` : '—'}
                          </Td>
                          <Td className="px-4 py-2 text-center">
                            <span className="rounded bg-brick-900/40 px-1.5 py-0.5 text-[11px] text-brick-400">
                              Alert
                            </span>
                          </Td>
                        </TRow>
                      ))}
                  </tbody>
                </Table>
              </div>
            )}
          </Card>
        }
      </QueryBoundary>
    </div>
  );
}
