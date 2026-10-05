import type { TicketGroup } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useId, useState } from 'react';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { requestHref } from '@/lib/requestDisplay';
import { safeHttpUrl } from '@/lib/safeUrl';
import { cn, FOCUS_RING, formatCost, formatRelativeTime } from '@/lib/utils';
import { PullRequestStateBadge } from './PullRequestBadges';

const LINK = 'text-ember-400 hover:underline';

/** "2 succeeded, 1 failed": counts in words, in the order a reader cares about. */
export function runSummary(counts: TicketGroup['runCounts']): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count)
    .map(([status, count]) => `${count} ${status.replace(/_/g, ' ').toLowerCase()}`);
  return parts.length ? parts.join(', ') : 'No runs';
}

function TicketRow({ group }: { group: TicketGroup }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  // Tracker text is plain text; its link is followed only when it is http(s).
  const url = safeHttpUrl(group.url);
  return (
    <>
      <TRow hover>
        <Td className="px-4 py-3" primary>
          <div className="break-all font-medium text-paper-100">
            {url ? (
              <a className={LINK} href={url} rel="noopener noreferrer" target="_blank">
                {group.ticketId}
                <span className="sr-only"> (opens in the tracker, new tab)</span>
                <span aria-hidden="true"> ↗</span>
              </a>
            ) : (
              group.ticketId
            )}
          </div>
          {group.title && <div className="break-words text-xs text-paper-400">{group.title}</div>}
        </Td>
        <Td className="px-4 py-3 text-paper-300" label="Tracker status">
          {group.status ?? <span className="text-paper-500">—</span>}
        </Td>
        <Td className="px-4 py-3" label="Requests">
          {group.requestCount}
        </Td>
        <Td className="px-4 py-3" label="Runs">
          {group.latestRun ? (
            <div className="space-y-1">
              <Link
                aria-label={`Open latest run, ${group.latestRun.status.toLowerCase()}`}
                className="inline-block"
                href={`/runs/${group.latestRun.id}`}
              >
                <StatusBadge status={group.latestRun.status} />
              </Link>
              <div className="text-xs text-paper-400">{runSummary(group.runCounts)}</div>
            </div>
          ) : (
            <span className="text-paper-500">No runs</span>
          )}
        </Td>
        <Td className="px-4 py-3" label="Pull requests">
          {group.pullRequests.length || <span className="text-paper-500">—</span>}
        </Td>
        <Td align="right" className="px-4 py-3 tabular-nums" label="Cost">
          {formatCost(group.costUsd)}
        </Td>
        <Td className="px-4 py-3 text-paper-400" label="Last activity">
          {formatRelativeTime(group.lastActivityAt)}
        </Td>
        <Td align="right" className="px-4 py-3">
          <button
            aria-controls={detailsId}
            aria-expanded={open}
            className={cn('rounded px-2 py-1 text-xs text-ember-400 hover:underline', FOCUS_RING)}
            onClick={() => setOpen((value) => !value)}
            type="button"
          >
            {open ? 'Hide' : 'Show'} details
            <span className="sr-only"> for {group.ticketId}</span>
          </button>
        </Td>
      </TRow>
      {open && (
        <tr id={detailsId}>
          <td className="bg-ink-800 px-4 py-3" colSpan={8}>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Link className={LINK} href={requestHref(group.latestWorkRequestId)}>
                Open latest request
              </Link>
              <Link
                className={LINK}
                href={`/workflows?scope=TEAM&search=${encodeURIComponent(group.ticketId)}`}
              >
                All requests for this ticket
              </Link>
            </div>
            {group.pullRequests.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-sm">
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
                          <span aria-hidden="true"> ↗</span>
                        </a>
                      ) : (
                        <span>{label}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function TicketTable({ groups }: { groups: TicketGroup[] }) {
  return (
    <Table stacked>
      <caption className="sr-only">Tickets with their requests, runs and pull requests</caption>
      <THead>
        <Th variant="plain">Ticket</Th>
        <Th variant="plain">Tracker status</Th>
        <Th variant="plain">Requests</Th>
        <Th variant="plain">Runs</Th>
        <Th variant="plain">PRs</Th>
        <Th align="right" variant="plain">
          Cost
        </Th>
        <Th variant="plain">Last activity</Th>
        <Th variant="plain">
          <span className="sr-only">Details</span>
        </Th>
      </THead>
      <tbody>
        {groups.map((group) => (
          <TicketRow group={group} key={group.ticketId} />
        ))}
      </tbody>
    </Table>
  );
}
