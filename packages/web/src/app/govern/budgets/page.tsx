'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { useUserOrgs } from '@/hooks/useAdmin';

function fmtCents(n: number | null): string {
  if (n == null) {
    return 'No cap';
  }
  return `$${(n / 100).toFixed(2)}`;
}

export default function AdminOrganizationsPage() {
  const { data: orgs, isLoading } = useUserOrgs();

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

      {isLoading ? (
        <LoadingState />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>All organizations</CardTitle>
          </CardHeader>
          {(orgs ?? []).length === 0 ? (
            <p className="px-4 pb-4 text-sm text-paper-400">No organizations found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-600 text-left text-xs text-paper-400">
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Slug</th>
                    <th className="px-4 py-2 font-medium">Role</th>
                    <th className="px-4 py-2 font-medium text-right">Monthly cap</th>
                    <th className="px-4 py-2 font-medium text-right">Spent</th>
                    <th className="px-4 py-2 font-medium text-right">Threshold</th>
                    <th className="px-4 py-2 font-medium text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(orgs ?? []).map((org) => (
                    <tr className="border-b border-ink-600 last:border-0" key={org.id}>
                      <td className="px-4 py-2">
                        <Link
                          className="text-ember-400 hover:underline"
                          href={`/govern/budgets/${org.id}`}
                        >
                          {org.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2 font-mono text-[11px] text-paper-400">{org.slug}</td>
                      <td className="px-4 py-2">{org.role}</td>
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
                      <td className="px-4 py-2 text-right">
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
