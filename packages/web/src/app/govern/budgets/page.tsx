'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useUserOrgs } from '@/hooks/useAdmin';

function fmtCents(n: number | null): string {
  if (n == null) {
    return 'No cap';
  }
  return `$${(n / 100).toFixed(2)}`;
}

export default function GovernBudgetsPage() {
  const { data: orgs, isLoading, isError, error: loadError } = useUserOrgs();

  const alertCount = (orgs ?? []).filter((o) => o.alert.triggered).length;

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="Organizations you belong to. Alerts fire when current month spend crosses the configured threshold."
        title="Organizations"
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
              <EmptyState className="px-4 pt-0 pb-4 text-left" title="No organizations found." />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <THead className="text-left text-xs text-paper-400">
                    <Th variant="dense">Name</Th>
                    <Th variant="dense">Slug</Th>
                    <Th variant="dense">Role</Th>
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
                      Status
                    </Th>
                  </THead>
                  <tbody>
                    {(orgs ?? []).map((org) => (
                      <TRow key={org.id}>
                        <Td className="px-4 py-2">
                          <Link
                            className="text-ember-400 hover:underline"
                            href={`/govern/budgets/${org.id}`}
                          >
                            {org.name}
                          </Link>
                        </Td>
                        <Td className="px-4 py-2 font-mono text-[11px] text-paper-400">
                          {org.slug}
                        </Td>
                        <Td className="px-4 py-2">{org.role}</Td>
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
                        <Td className="px-4 py-2 text-right">
                          {org.alert.triggered ? (
                            <span className="rounded bg-brick-900/40 px-1.5 py-0.5 text-[11px] text-brick-400">
                              {org.alert.percent != null
                                ? `${org.alert.percent.toFixed(1)}%`
                                : 'Alert'}
                            </span>
                          ) : (
                            <span className="rounded bg-moss-900/40 px-1.5 py-0.5 text-[11px] text-moss-400">
                              OK
                            </span>
                          )}
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
