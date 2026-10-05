import type { PullRequestListItem } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { requestHref } from '@/lib/requestDisplay';
import { safeHttpUrl } from '@/lib/safeUrl';
import { formatCost, formatRelativeTime } from '@/lib/utils';
import { CiBadge, PullRequestStateBadge } from './PullRequestBadges';

const LINK = 'text-ember-400 hover:underline';

/** Title and ticket are host and tracker text: rendered as plain text, never as markup. */
export function PullRequestTable({ pullRequests }: { pullRequests: PullRequestListItem[] }) {
  return (
    <Table stacked>
      <caption className="sr-only">Pull requests opened by the platform, newest first</caption>
      <THead>
        <Th variant="plain">Pull request</Th>
        <Th variant="plain">State</Th>
        <Th variant="plain">Ticket</Th>
        <Th variant="plain">Run</Th>
        <Th align="right" variant="plain">
          Cost
        </Th>
        <Th variant="plain">Opened</Th>
      </THead>
      <tbody>
        {pullRequests.map((pr) => {
          const url = safeHttpUrl(pr.url);
          const name = pr.repository
            ? `${pr.repository.org}/${pr.repository.name}`
            : 'Unknown repository';
          const label = `${name}${pr.prNumber == null ? '' : ` #${pr.prNumber}`}`;
          return (
            <TRow hover key={pr.id}>
              <Td className="px-4 py-3" primary>
                <div className="break-words font-medium text-paper-100">
                  {pr.title ?? 'Untitled pull request'}
                </div>
                <div className="text-xs text-paper-400">
                  {url ? (
                    <a className={LINK} href={url} rel="noopener noreferrer" target="_blank">
                      {label}
                      <span className="sr-only"> (opens on the host, new tab)</span>
                      <span aria-hidden="true"> ↗</span>
                    </a>
                  ) : (
                    label
                  )}
                </div>
              </Td>
              <Td className="px-4 py-3" label="State">
                <div className="flex flex-wrap gap-1.5">
                  <PullRequestStateBadge isDraft={pr.isDraft} status={pr.status} />
                  {pr.status === 'OPEN' && <CiBadge status={pr.ciStatus} />}
                </div>
              </Td>
              <Td className="px-4 py-3" label="Ticket">
                {pr.ticketId ? (
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
                )}
              </Td>
              <Td className="px-4 py-3" label="Run">
                {pr.latestRun ? (
                  <Link
                    aria-label={`Open run, ${pr.latestRun.status.toLowerCase()}`}
                    className="inline-block"
                    href={`/runs/${pr.latestRun.id}`}
                  >
                    <StatusBadge status={pr.latestRun.status} />
                  </Link>
                ) : (
                  <span className="text-paper-500">—</span>
                )}
              </Td>
              <Td align="right" className="px-4 py-3 tabular-nums" label="Cost">
                {formatCost(pr.costUsd)}
              </Td>
              <Td className="px-4 py-3 text-paper-400" label="Opened">
                {formatRelativeTime(pr.openedAt)}
              </Td>
            </TRow>
          );
        })}
      </tbody>
    </Table>
  );
}
