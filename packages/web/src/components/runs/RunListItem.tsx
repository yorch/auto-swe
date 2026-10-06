import type { WorkflowRunSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { requestHref } from '@/lib/requestDisplay';
import {
  cn,
  FOCUS_RING,
  formatCost,
  formatDate,
  formatDuration,
  formatRelativeTime,
} from '@/lib/utils';

/**
 * One run in a history list. The title opens the request panel (the run's
 * request, with its result and approvals); "Diagnostics" opens the full run
 * page. A run with no request goes straight to diagnostics. From `sm` up the
 * row reads as one line — status, title, then duration, cost and start time in
 * fixed columns so a page of runs scans down; on a phone the figures wrap under
 * the title instead of scrolling a table.
 */
export function RunListItem({ run }: { run: WorkflowRunSummary }) {
  const diagnostics = `/runs/${run.id}`;
  const title =
    run.workRequest?.title ||
    run.workRequest?.description ||
    run.workRequest?.externalTicketId ||
    run.templateName ||
    'Untitled run';
  const durationMs = run.endedAt
    ? Math.max(0, new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime())
    : null;
  const ticket = run.workRequest?.externalTicketId;
  return (
    <li className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-ink-600/35 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
      <div className="shrink-0 sm:w-28">
        <StatusBadge status={run.status} />
      </div>

      <div className="min-w-0 flex-1">
        <Link
          className={cn(
            'line-clamp-2 break-words rounded-sm text-sm font-medium text-paper-100 transition-colors hover:text-ember-400 sm:line-clamp-1',
            FOCUS_RING
          )}
          href={run.workRequest ? requestHref(run.workRequest.id) : diagnostics}
          title={title}
        >
          {title}
        </Link>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-paper-500">
          {ticket && (
            <>
              <span className="font-mono text-paper-400">{ticket}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="min-w-0 truncate">
            {run.templateName ?? 'Workflow'} <span className="tabular">v{run.templateVersion}</span>
          </span>
        </div>
      </div>

      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-paper-400 sm:flex-nowrap sm:gap-5">
        <div className="flex items-center gap-1.5 whitespace-nowrap sm:w-24 sm:justify-end">
          <dt className="sr-only">Duration</dt>
          <Icon className="text-paper-600" name="clock" size={13} />
          <dd className="tabular">
            {durationMs !== null ? (
              formatDuration(durationMs)
            ) : (
              <span className="text-dust-400">Still running</span>
            )}
          </dd>
        </div>
        {/* A running run's cost is still accruing; the figure would be stale by the time it is read. */}
        <div className="flex items-center gap-1.5 sm:w-20 sm:justify-end">
          <dt className="sr-only">Cost</dt>
          <dd className="tabular">
            {run.status === 'RUNNING'
              ? '—'
              : run.costUsdAccrued === 0
                ? '$0.00'
                : formatCost(run.costUsdAccrued)}
          </dd>
        </div>
        <div className="sm:w-20 sm:text-right">
          <dt className="sr-only">Started</dt>
          <dd className="tabular" title={`Started ${formatDate(run.startedAt)}`}>
            {formatRelativeTime(run.startedAt)}
          </dd>
        </div>
      </dl>

      <Link
        aria-label={`Diagnostics for ${title}`}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 self-start rounded-sm text-[13px] text-ember-400 transition-colors hover:text-ember-300 sm:self-center',
          FOCUS_RING
        )}
        href={diagnostics}
      >
        Diagnostics
        <Icon name="chevronRight" size={14} />
      </Link>
    </li>
  );
}
