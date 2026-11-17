'use client';

import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useRunPlans } from '@/hooks/useRunPlans';
import { formatUsd } from '@/lib/runPlan';

const TONE: Record<string, BadgeTone> = {
  APPROVED: 'info',
  EXPIRED: 'neutral',
  LAUNCHED: 'success',
  PENDING: 'warning',
  REJECTED: 'danger',
};

/** The caller's own plans, newest first. Intent text is shown as plain text. */
export function MyPlans({ onOpen }: { onOpen: (planId: string) => void }) {
  const plans = useRunPlans();
  const rows = plans.data?.data ?? [];
  return (
    <Card className="space-y-3 p-5" variant="inset">
      <h3 className="text-sm font-semibold text-paper-100" id="my-plans-title">
        My plans
      </h3>
      <QueryBoundary
        error={plans.error}
        isError={plans.isError}
        isFetching={plans.isFetching}
        isLoading={plans.isLoading}
        label="plans"
        onRetry={() => void plans.refetch()}
      >
        {rows.length === 0 ? (
          <p className="text-sm text-paper-400">You have no plans yet.</p>
        ) : (
          <ul aria-labelledby="my-plans-title" className="divide-y divide-ink-600">
            {rows.map((plan) => (
              <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" key={plan.id}>
                <Badge tone={TONE[plan.status] ?? 'neutral'} variant="outline">
                  {plan.status}
                </Badge>
                <span
                  className="min-w-0 flex-1 truncate text-sm text-paper-200"
                  title={plan.intent}
                >
                  {plan.intent}
                </span>
                <span className="text-xs text-paper-500">{formatUsd(plan.totalUsd)}</span>
                <RelativeTime className="text-xs text-paper-500" value={plan.createdAt} />
                <Button onClick={() => onOpen(plan.id)} size="sm" variant="ghost">
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Card>
  );
}
