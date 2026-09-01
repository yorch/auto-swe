'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { useBudgetAlerts } from '@/hooks/useOrg';

function fmtCents(n: number | null): string {
  if (n == null) {
    return 'No cap';
  }
  return `$${(n / 100).toFixed(2)}`;
}

export default function BudgetAlertsPage() {
  const { data: orgs, isLoading } = useBudgetAlerts();
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

      {isLoading ? (
        <LoadingState />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Alerting organizations</CardTitle>
          </CardHeader>
          {(orgs ?? []).length === 0 ? (
            <p className="px-4 pb-4 text-sm text-paper-400">No organizations found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-600 text-left text-xs text-paper-400">
                    <th className="px-4 py-2 font-medium">Organization</th>
                    <th className="px-4 py-2 font-medium text-right">Monthly cap</th>
                    <th className="px-4 py-2 font-medium text-right">Spent</th>
                    <th className="px-4 py-2 font-medium text-right">Threshold</th>
                    <th className="px-4 py-2 font-medium text-right">% used</th>
                    <th className="px-4 py-2 font-medium text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(orgs ?? [])
                    .filter((o) => o.alert.triggered)
                    .map((org) => (
                      <tr className="border-b border-ink-600 last:border-0" key={org.id}>
                        <td className="px-4 py-2">
                          <Link
                            className="text-ember-400 hover:underline"
                            href={`/admin/organizations/${org.id}`}
                          >
                            {org.name}
                          </Link>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {fmtCents(org.monthlyBudgetUsdCents)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {org.currentMonthUsage
                            ? `$${org.currentMonthUsage.costUsdAccrued.toFixed(2)}`
                            : '$0.00'}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {org.budgetAlertThresholdPercent != null
                            ? `${org.budgetAlertThresholdPercent}%`
                            : '—'}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {org.alert.percent != null ? `${org.alert.percent.toFixed(1)}%` : '—'}
                        </td>
                        <td className="px-4 py-2 text-center">
                          <span className="rounded bg-brick-900/40 px-1.5 py-0.5 text-[11px] text-brick-400">
                            Alert
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
