import type { WorkflowRunSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { requestHref } from '@/lib/requestDisplay';
import { formatCost, formatDuration, formatRelativeTime } from '@/lib/utils';

/**
 * One run in a history list. The title opens the request panel (the run's
 * request, with its result and approvals); "Diagnostics" opens the full run
 * page. A run with no request goes straight to diagnostics. Rows stack at
 * phone width instead of scrolling a table.
 */
export function RunListItem({ run }: { run: WorkflowRunSummary }) {
  const diagnostics = `/runs/${run.id}`;
  const title =
    run.workRequest?.title ||
    run.workRequest?.description ||
    run.workRequest?.externalTicketId ||
    run.templateName ||
    'Untitled run';
  const duration = run.endedAt
    ? formatDuration(
        Math.max(0, new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime())
      )
    : null;
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 py-4">
      <div className="min-w-0 flex-1">
        <Link
          className="line-clamp-2 break-words text-sm font-semibold text-paper-100 hover:text-ember-400"
          href={run.workRequest ? requestHref(run.workRequest.id) : diagnostics}
        >
          {title}
        </Link>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-paper-400">
          {run.workRequest?.externalTicketId && <span>{run.workRequest.externalTicketId}</span>}
          <span>
            {run.templateName ?? 'Workflow'} v{run.templateVersion}
          </span>
          <span>Started {formatRelativeTime(run.startedAt)}</span>
          <span>{duration ? `Took ${duration}` : 'Still running'}</span>
          {run.status !== 'RUNNING' && (
            <span>{run.costUsdAccrued === 0 ? '$0.00' : formatCost(run.costUsdAccrued)}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <StatusBadge status={run.status} />
        <Link
          aria-label={`Diagnostics for ${title}`}
          className="text-sm text-ember-400 hover:underline"
          href={diagnostics}
        >
          Diagnostics
        </Link>
      </div>
    </li>
  );
}
