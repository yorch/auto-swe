import type { TicketGroup } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { requestHref } from '@/lib/requestDisplay';
import { safeHttpUrl } from '@/lib/safeUrl';
import { cn, FOCUS_RING, formatCost } from '@/lib/utils';
import { PullRequestStateBadge } from './PullRequestBadges';

const LINK = cn(
  'rounded-sm text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
  FOCUS_RING
);

/** "2 succeeded, 1 failed": counts in words, in the order a reader cares about. */
export function runSummary(counts: TicketGroup['runCounts']): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count)
    .map(([status, count]) => `${count} ${status.replace(/_/g, ' ').toLowerCase()}`);
  return parts.length ? parts.join(', ') : 'No runs';
}

const dash = <span className="text-paper-500">—</span>;

const COLUMNS: DataTableColumn<TicketGroup>[] = [
  {
    // The row opens the latest request; the tracker link is a separate, labelled link beneath.
    cell: (group) => group.title ?? group.ticketId,
    header: 'Ticket',
    id: 'ticket',
    primary: true,
    secondary: (group) => {
      // Tracker text is plain text; its link is followed only when it is http(s).
      const url = safeHttpUrl(group.url);
      const label = group.title ? group.ticketId : 'Tracker';
      return url ? (
        <a className={LINK} href={url} rel="noopener noreferrer" target="_blank">
          <span className={cn(group.title && 'font-mono')}>{label}</span>
          <span className="sr-only"> (opens in the tracker, new tab)</span>
          <Icon className="ml-1 inline align-[-1px]" name="external" size={11} />
        </a>
      ) : group.title ? (
        <span className="font-mono">{group.ticketId}</span>
      ) : null;
    },
  },
  {
    cell: (group) => group.status ?? dash,
    header: 'Tracker status',
    id: 'status',
  },
  {
    align: 'right',
    cell: (group) => <span className="tabular text-paper-200">{group.requestCount}</span>,
    header: 'Requests',
    id: 'requests',
  },
  {
    cell: (group) =>
      group.latestRun ? (
        <div className="space-y-1">
          <Link
            aria-label={`Open latest run, ${group.latestRun.status.toLowerCase()}`}
            className={cn('inline-flex items-center gap-1 hover:underline', FOCUS_RING)}
            href={`/runs/${group.latestRun.id}`}
          >
            <StatusBadge status={group.latestRun.status} />
            <Icon name="arrowRight" size={12} />
          </Link>
          <div className="text-xs text-paper-400">{runSummary(group.runCounts)}</div>
        </div>
      ) : (
        <span className="text-paper-500">No runs</span>
      ),
    header: 'Runs',
    id: 'runs',
  },
  {
    cell: (group) =>
      group.pullRequests.length ? (
        <ul className="space-y-1.5 text-sm">
          {group.pullRequests.map((pr) => {
            const prUrl = safeHttpUrl(pr.url);
            const label = `${pr.repository ? `${pr.repository.org}/${pr.repository.name}` : 'Unknown repository'}${pr.prNumber == null ? '' : ` #${pr.prNumber}`}`;
            return (
              <li className="flex flex-wrap items-center gap-2" key={pr.id}>
                <PullRequestStateBadge isDraft={pr.isDraft} status={pr.status} />
                {prUrl ? (
                  <a className={LINK} href={prUrl} rel="noopener noreferrer" target="_blank">
                    {label}
                    <span className="sr-only"> (opens on the host, new tab)</span>
                    <Icon className="ml-1 inline align-[-1px]" name="external" size={11} />
                  </a>
                ) : (
                  <span>{label}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        dash
      ),
    header: 'Pull requests',
    id: 'pull-requests',
  },
  {
    align: 'right',
    cell: (group) => <span className="tabular text-paper-200">{formatCost(group.costUsd)}</span>,
    header: 'Cost',
    id: 'cost',
  },
  {
    cell: (group) => (
      <span className="whitespace-nowrap text-paper-400">
        <RelativeTime value={group.lastActivityAt} />
      </span>
    ),
    header: 'Last activity',
    id: 'last-activity',
  },
];

/** Each row opens the ticket's latest request; its pull requests are listed in the row. */
export function TicketTable({ groups }: { groups: TicketGroup[] }) {
  return (
    <DataTable
      caption="Tickets with their requests, runs and pull requests"
      columns={COLUMNS}
      getRowId={(group) => group.ticketId}
      rowHref={(group) => requestHref(group.latestWorkRequestId)}
      rows={groups}
    />
  );
}
