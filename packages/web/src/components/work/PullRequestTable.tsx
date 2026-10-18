import type { PullRequestListItem } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { requestHref } from '@/lib/requestDisplay';
import { safeHttpUrl } from '@/lib/safeUrl';
import { cn, FOCUS_RING, formatCost } from '@/lib/utils';
import { CiBadge, PullRequestStateBadge } from './PullRequestBadges';

const LINK = cn(
  'rounded-sm text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
  FOCUS_RING
);

function prLabel(pr: PullRequestListItem): string {
  const name = pr.repository ? `${pr.repository.org}/${pr.repository.name}` : 'Unknown repository';
  return `${name}${pr.prNumber == null ? '' : ` #${pr.prNumber}`}`;
}

const COLUMNS: DataTableColumn<PullRequestListItem>[] = [
  {
    cell: (pr) => pr.title ?? 'Untitled pull request',
    header: 'Pull request',
    id: 'pull-request',
    primary: true,
    secondary: (pr) => {
      const url = safeHttpUrl(pr.url);
      const label = prLabel(pr);
      return url ? (
        <a className={LINK} href={url} rel="noopener noreferrer" target="_blank">
          {label}
          <span className="sr-only"> (opens on the host, new tab)</span>
          <Icon className="ml-1 inline align-[-1px]" name="external" size={11} />
        </a>
      ) : (
        label
      );
    },
  },
  {
    cell: (pr) => (
      <div className="flex flex-wrap gap-1.5">
        <PullRequestStateBadge isDraft={pr.isDraft} status={pr.status} />
        {pr.status === 'OPEN' && <CiBadge status={pr.ciStatus} />}
      </div>
    ),
    header: 'State',
    id: 'state',
  },
  {
    cell: (pr) =>
      pr.ticketId ? (
        <span className="break-all">
          {pr.workRequestId ? (
            <Link className={LINK} href={requestHref(pr.workRequestId)}>
              {pr.ticketId}
            </Link>
          ) : (
            pr.ticketId
          )}
        </span>
      ) : (
        <span className="text-paper-500">—</span>
      ),
    header: 'Ticket',
    id: 'ticket',
  },
  {
    cell: (pr) =>
      pr.latestRun ? (
        <Link
          aria-label={`Open run, ${pr.latestRun.status.toLowerCase()}`}
          className="inline-block"
          href={`/runs/${pr.latestRun.id}`}
        >
          <StatusBadge status={pr.latestRun.status} />
        </Link>
      ) : (
        <span className="text-paper-500">—</span>
      ),
    header: 'Run',
    id: 'run',
  },
  {
    align: 'right',
    cell: (pr) => <span className="tabular text-paper-200">{formatCost(pr.costUsd)}</span>,
    header: 'Cost',
    id: 'cost',
  },
  {
    cell: (pr) => (
      <span className="whitespace-nowrap text-paper-400">
        <RelativeTime value={pr.openedAt} />
      </span>
    ),
    header: 'Opened',
    id: 'opened',
  },
];

/**
 * Title and ticket are host and tracker text: rendered as plain text, never as markup. The
 * title is not a link: the pull request lives on its host, so the host link sits under it.
 */
export function PullRequestTable({ pullRequests }: { pullRequests: PullRequestListItem[] }) {
  return (
    <DataTable
      caption="Pull requests opened by the platform, newest first"
      columns={COLUMNS}
      getRowId={(pr) => pr.id}
      rows={pullRequests}
    />
  );
}
