import type { PullRequestListItem } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { requestHref } from '@/lib/requestDisplay';
import { safeHttpUrl } from '@/lib/safeUrl';
import { cn, FOCUS_RING, formatCost } from '@/lib/utils';
import { CiBadge, PullRequestStateBadge } from './PullRequestBadges';

const LINK = cn('rounded-sm text-ember-400 hover:underline', FOCUS_RING);

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
                <div className="break-words text-sm font-medium text-paper-100">
                  {pr.title ?? 'Untitled pull request'}
                </div>
                <div className="mt-0.5 text-xs font-normal text-paper-400">
                  {url ? (
                    <a className={LINK} href={url} rel="noopener noreferrer" target="_blank">
                      {label}
                      <span className="sr-only"> (opens on the host, new tab)</span>
                      <Icon className="ml-1 inline align-[-1px]" name="external" size={11} />
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
              <Td align="right" className="tabular px-4 py-3 text-paper-200" label="Cost">
                {formatCost(pr.costUsd)}
              </Td>
              <Td className="whitespace-nowrap px-4 py-3 text-paper-400" label="Opened">
                <RelativeTime value={pr.openedAt} />
              </Td>
            </TRow>
          );
        })}
      </tbody>
    </Table>
  );
}
