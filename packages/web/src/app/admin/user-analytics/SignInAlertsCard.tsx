'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useSignInAlerts } from '@/hooks/useAdmin';
import { methodLabel } from './labels';

/**
 * Accounts with repeated failed sign-ins in the alert window. A failed load is shown as unknown,
 * never as an empty list, because "no alerts" is the one answer an admin must be able to trust.
 */
export function SignInAlertsCard() {
  const alerts = useSignInAlerts();
  const data = alerts.data;

  if ((alerts.isError && !data) || (data && !Array.isArray(data.alerts))) {
    return (
      <Alert
        action={
          <Button onClick={() => void alerts.refetch()} size="sm">
            Retry
          </Button>
        }
        variant="error"
      >
        Failed sign-in alerts could not be loaded, so whether any account is over the threshold is
        unknown — not zero.
      </Alert>
    );
  }
  if (!data) {
    return (
      <p className="text-sm text-paper-500" role="status">
        Checking failed sign-in alerts…
      </p>
    );
  }
  const perMinute = data.failuresRecordedPerMinute;
  const unreachable = data.thresholdReachable === false;
  const note =
    perMinute === undefined ? null : (
      <p className="mt-1 text-xs text-paper-500">
        At most {perMinute} failed sign-ins per account are recorded each minute
        {data.maxRecordable === undefined ? '' : ` (${data.maxRecordable} in this window)`}, so a
        threshold above that can never fire.
      </p>
    );
  if (data.alerts.length === 0) {
    return (
      <div>
        {unreachable && (
          <Alert variant="warning">
            The threshold of {data.threshold} failed sign-ins is above the most one account can have
            recorded in {data.windowMinutes} minutes, so no alert can fire. Lower the threshold or
            lengthen the window.
          </Alert>
        )}
        <Alert announce={false} variant="success">
          No accounts over threshold in the last {data.windowMinutes} minutes ({data.threshold}{' '}
          failed sign-ins).
        </Alert>
        {note}
      </div>
    );
  }
  return (
    <Card className="border-danger-400/35 p-4 sm:p-6">
      <CardHeader>
        <CardTitle>
          {data.alerts.length} account{data.alerts.length === 1 ? '' : 's'} over the failed sign-in
          threshold
        </CardTitle>
      </CardHeader>
      <p className="mb-3 text-sm text-paper-400">
        {data.threshold} or more failed sign-ins within {data.windowMinutes} minutes.
        {data.truncated ? ' Only the worst accounts are listed.' : ''}
      </p>
      {note}
      <ul
        aria-label="Accounts over the failed sign-in threshold"
        className="divide-y divide-ink-600"
      >
        {data.alerts.map((a) => (
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm" key={a.userId}>
            <Link
              className="font-medium text-accent-400 hover:underline"
              href={`/admin/user-analytics/users/${a.userId}`}
            >
              {a.name ? `${a.name} (${a.email ?? 'no email'})` : (a.email ?? a.userId)}
            </Link>
            <Badge tone="danger">{a.failures} failed</Badge>
            {a.signedInAfter && <Badge tone="warning">Signed in afterwards</Badge>}
            <span className="text-paper-500">
              {a.methods.map((m) => methodLabel(m)).join(', ')}
            </span>
            {a.lastAt && (
              <span className="ml-auto text-paper-500">
                last <RelativeTime value={a.lastAt} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
