'use client';

import type { MeNeedsYouItem, MeNeedsYouKind } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { Icon, type IconName } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { requestHref } from '@/lib/requestDisplay';
import { cn, FOCUS_RING } from '@/lib/utils';

const KIND: Record<
  MeNeedsYouKind,
  { icon: IconName; label: string; action: string; tone: string }
> = {
  approval: { action: 'Review', icon: 'gavel', label: 'Approval', tone: 'text-accent-400' },
  approval_due_soon: {
    action: 'Review',
    icon: 'clock',
    label: 'Approval due soon',
    tone: 'text-warning-400',
  },
  failed_run: { action: 'Open run', icon: 'warning', label: 'Failed run', tone: 'text-danger-400' },
  pr_merge: {
    action: 'Review PR',
    icon: 'pullRequest',
    label: 'Pull request to merge',
    tone: 'text-info-400',
  },
};

/** Where the row's action goes. A kind with nothing to point at falls back to its list. */
export function needsYouHref(item: MeNeedsYouItem): string {
  switch (item.kind) {
    case 'approval':
    case 'approval_due_soon':
      return '/approvals';
    case 'failed_run':
      if (item.runId) {
        return `/runs/${encodeURIComponent(item.runId)}`;
      }
      return item.requestId ? requestHref(item.requestId) : '/requests?state=attention';
    case 'pr_merge':
      return item.requestId ? requestHref(item.requestId) : '/pull-requests';
  }
}

function NeedsYouRow({ item }: { item: MeNeedsYouItem }) {
  const kind = KIND[item.kind];
  const dueSoon = item.kind === 'approval_due_soon';
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" data-kind={item.kind}>
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-ink-400 bg-ink-800',
          kind.tone
        )}
        title={kind.label}
      >
        <Icon name={kind.icon} size={16} />
        <span className="sr-only">{kind.label}</span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-paper-100">{item.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-paper-500">
          <Badge tone={item.teamName ? 'accent' : 'neutral'} variant="outline">
            {item.teamName ?? 'No team'}
          </Badge>
          {item.repoName && <span>{item.repoName}</span>}
          {item.dueAt && (
            <span className={cn(dueSoon && 'font-medium text-warning-400')}>
              Due <RelativeTime value={item.dueAt} />
            </span>
          )}
        </div>
      </div>
      <Link
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-sm text-sm font-medium text-accent-400 hover:underline',
          FOCUS_RING
        )}
        href={needsYouHref(item)}
      >
        {kind.action}
        <span className="sr-only">: {item.title}</span>
        <Icon name="arrowRight" size={13} />
      </Link>
    </li>
  );
}

/** Everything waiting on the signed-in user across all their teams, most urgent first. */
export function NeedsYouList({ items, total }: { items: MeNeedsYouItem[]; total: number }) {
  const overflow = total > items.length;
  // The full list lives where the rows lead: approvals for gates, requests for the rest.
  const allHref = items.some((i) => i.kind === 'approval' || i.kind === 'approval_due_soon')
    ? '/approvals'
    : '/requests?state=attention';
  return (
    <section aria-labelledby="needs-you-title" id="needs-you">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2
          className="flex items-center gap-2 text-lg font-semibold tracking-tight text-paper-100"
          id="needs-you-title"
        >
          Needs you
          {total > 0 && (
            <span className="tabular rounded-full bg-ink-600 px-2 text-xs font-medium text-paper-300">
              {total}
            </span>
          )}
          <HelpTip label="Needs you">
            Approvals you can answer, approvals about to time out, failed runs and pull requests
            ready to merge, across every team you belong to.
          </HelpTip>
        </h2>
        {overflow && (
          <span className="flex flex-wrap items-center gap-x-3 text-sm text-paper-500">
            Showing {items.length} of {total}
            <Link
              className={cn(
                'inline-flex items-center gap-1 rounded-sm text-paper-100 underline-offset-2 hover:underline',
                FOCUS_RING
              )}
              href={allHref}
            >
              View all
              <Icon name="arrowRight" size={13} />
            </Link>
          </span>
        )}
      </div>
      {items.length ? (
        <Card className="p-0 sm:p-0">
          <ul className="divide-y divide-ink-600">
            {items.map((item) => (
              <NeedsYouRow item={item} key={item.key} />
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState
          bordered
          className="py-7"
          hint="Approvals, failed runs and pull requests that are waiting on you show up here."
          icon="checkCircle"
          title="Nothing needs you"
        />
      )}
    </section>
  );
}
