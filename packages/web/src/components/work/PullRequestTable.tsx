import type { PullRequestListItem } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { TeamLabel } from '@/components/teams/TeamLabel';
import { BUTTON_STYLE, buttonClassName } from '@/components/ui/Button';
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

const BATCH_LABELS = {
  deep: 'Deep review',
  none: 'No review needed',
  quick: 'Quick review',
  standard: 'Standard review',
} as const;

const REASON_LABELS: Record<string, string> = {
  approvals_met: 'approvals already in place',
  below_threshold: 'below the routing thresholds',
  bot_approved: 'approved by the bot',
  bot_approved_review: 'approved by the bot, a person still looks',
  changes_requested: 'a person asked for changes',
  draft: 'still a draft',
  not_evaluated: 'not evaluated at this head',
  not_open: 'not open',
  path: 'touches a path that always needs a person',
  risk: 'risk class',
  size: 'larger than the routing size limit',
};

function columnsFor(viewerTeamId?: string): DataTableColumn<PullRequestListItem>[] {
  return [
    {
      // A row with no repository or number has nothing to review here, so it stays plain text.
      cell: (pr) =>
        pr.repository && pr.prNumber !== null ? (
          <Link className={LINK} href={`/pull-requests/${pr.id}`}>
            {pr.title ?? 'Untitled pull request'}
          </Link>
        ) : (
          (pr.title ?? 'Untitled pull request')
        ),
      header: 'Pull request',
      id: 'pull-request',
      primary: true,
      secondary: (pr) => {
        const url = safeHttpUrl(pr.url);
        const label = prLabel(pr);
        const owner = pr.ownerTeam ? [pr.ownerTeam] : [];
        return (
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <TeamLabel teams={owner} viewerTeamId={viewerTeamId} />
            {url ? (
              <a className={LINK} href={url} rel="noopener noreferrer" target="_blank">
                {label}
                <span className="sr-only"> (opens on the host, new tab)</span>
                <Icon className="ml-1 inline align-[-1px]" name="external" size={11} />
              </a>
            ) : (
              label
            )}
          </span>
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
      // Plain text: the reason and batch are fixed labels, the matched path is repository text.
      cell: (pr) =>
        pr.review ? (
          <div className="text-xs">
            <span className={pr.review.needsHuman ? 'text-paper-100' : 'text-paper-500'}>
              {pr.review.position !== null && `${pr.review.position}. `}
              {BATCH_LABELS[pr.review.batch]}
            </span>
            <span className="block text-paper-500">
              {pr.review.riskClass ? `${pr.review.riskClass.toLowerCase()} risk, ` : ''}
              {REASON_LABELS[pr.review.reason] ?? pr.review.reason}
              {pr.review.matchedPath ? `: ${pr.review.matchedPath}` : ''}
            </span>
          </div>
        ) : (
          <span className="text-paper-500">—</span>
        ),
      header: 'Attention',
      id: 'attention',
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
            className={cn('inline-flex items-center gap-1 hover:underline', FOCUS_RING)}
            href={`/runs/${pr.latestRun.id}`}
          >
            <StatusBadge status={pr.latestRun.status} />
            <Icon name="arrowRight" size={12} />
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
}

/**
 * Title and ticket are host and tracker text: rendered as plain text, never as markup. The
 * title opens the review page; the pull request itself lives on its host, so the host link sits
 * under it.
 */
export function PullRequestTable({
  ordered = false,
  pullRequests,
  viewerTeamId,
}: {
  /** The rows are in review-queue order rather than newest first. */
  ordered?: boolean;
  pullRequests: PullRequestListItem[];
  /** Inside a team's space: owners other than this team read "owned by …". */
  viewerTeamId?: string;
}) {
  return (
    <DataTable
      actions={(pr) => {
        const url = safeHttpUrl(pr.url);
        return url ? (
          <a
            className={buttonClassName('secondary', 'sm')}
            href={url}
            rel="noopener noreferrer"
            style={BUTTON_STYLE}
            target="_blank"
          >
            Review
            <span className="sr-only"> {prLabel(pr)} on the host (opens in a new tab)</span>
            <Icon name="external" size={12} />
          </a>
        ) : null;
      }}
      actionsLabel="Review"
      caption={
        ordered
          ? 'Open pull requests opened by the platform, in review order'
          : 'Pull requests opened by the platform, newest first'
      }
      columns={columnsFor(viewerTeamId)}
      getRowId={(pr) => pr.id}
      revealActions={false}
      rows={pullRequests}
    />
  );
}
