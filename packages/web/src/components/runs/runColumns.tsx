import type { WorkflowRunSummary } from '@auto-swe/shared/types/api';
import { isTerminalWorkflowRunStatus } from '@auto-swe/shared/types/api';
import type { ReactNode } from 'react';
import type { DataTableColumn } from '@/components/ui/DataTable';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatCost, formatDuration } from '@/lib/utils';

/**
 * The column set shared by every list of runs and requests, in one order:
 * status, title, workflow, duration, cost, then a time. A list picks its own
 * title wording, the time it shows, and whatever it adds under the title or
 * the workflow name.
 */
export function workTitle(
  run: Pick<WorkflowRunSummary, 'workRequest' | 'templateName'>,
  fallback: string
): string {
  return (
    run.workRequest?.title ||
    run.workRequest?.description ||
    run.workRequest?.externalTicketId ||
    run.templateName ||
    fallback
  );
}

export function statusColumn<Row extends WorkflowRunSummary>(): DataTableColumn<Row> {
  return {
    cell: (row) => <StatusBadge status={row.status} />,
    header: 'Status',
    id: 'status',
    width: 'sm:w-28',
  };
}

export function titleColumn<Row extends WorkflowRunSummary>(
  fallback: string,
  secondary: (row: Row) => ReactNode
): DataTableColumn<Row> {
  return {
    cell: (row) => workTitle(row, fallback),
    header: 'Title',
    id: 'title',
    primary: true,
    secondary,
  };
}

export function workflowColumn<Row extends WorkflowRunSummary>(
  extra?: (row: Row) => ReactNode
): DataTableColumn<Row> {
  return {
    cell: (row) => (
      <div className="min-w-0">
        <div className="truncate text-sm text-paper-300">
          {row.templateName ?? 'Workflow'}{' '}
          <span className="tabular text-paper-500">v{row.templateVersion}</span>
        </div>
        {extra?.(row)}
      </div>
    ),
    header: 'Workflow',
    id: 'workflow',
  };
}

/**
 * What a run with no end time shows. Only a run that is still going says so: a finished run
 * with no recorded end time shows a dash, and a request waiting on a person says it is waiting
 * rather than running. Only the requests list carries that count; the workflow-runs list does not,
 * so there a run parked on a human gate still reads as running.
 */
export function openRunLabel(
  row: Pick<WorkflowRunSummary, 'status'> & { pendingStepCount?: number }
): { text: string; tone: 'info' | 'warning' | 'none' } {
  if (isTerminalWorkflowRunStatus(row.status)) {
    return { text: '—', tone: 'none' };
  }
  if ((row.pendingStepCount ?? 0) > 0) {
    return { text: 'Waiting for approval', tone: 'warning' };
  }
  return { text: 'Still running', tone: 'info' };
}

export function durationColumn<Row extends WorkflowRunSummary>(): DataTableColumn<Row> {
  return {
    align: 'right',
    cell: (row) => {
      const ms = row.endedAt
        ? Math.max(0, new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime())
        : null;
      const open = openRunLabel(row);
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-paper-400">
          <Icon className="text-paper-600" name="clock" size={13} />
          <span className="tabular">
            {ms !== null ? (
              formatDuration(ms)
            ) : (
              <span
                className={
                  open.tone === 'info'
                    ? 'text-info-400'
                    : open.tone === 'warning'
                      ? 'text-warning-400'
                      : undefined
                }
              >
                {open.text}
              </span>
            )}
          </span>
        </span>
      );
    },
    header: 'Duration',
    id: 'duration',
  };
}

/** A running run's cost is still accruing; the figure would be stale by the time it is read. */
export function costColumn<Row extends WorkflowRunSummary>(): DataTableColumn<Row> {
  return {
    align: 'right',
    cell: (row) => (
      <span className="tabular text-xs text-paper-400">
        {!isTerminalWorkflowRunStatus(row.status)
          ? '—'
          : row.costUsdAccrued === 0
            ? '$0.00'
            : formatCost(row.costUsdAccrued)}
      </span>
    ),
    header: 'Cost',
    id: 'cost',
  };
}

export function timeColumn<Row extends WorkflowRunSummary>(
  header: string,
  pick: (row: Row) => string
): DataTableColumn<Row> {
  return {
    align: 'right',
    cell: (row) => <RelativeTime className="text-xs text-paper-400" value={pick(row)} />,
    header,
    id: 'time',
  };
}
