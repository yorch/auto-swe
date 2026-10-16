'use client';

import type { WorkflowRunSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { DataTable } from '@/components/ui/DataTable';
import { Icon } from '@/components/ui/Icon';
import { runHref } from '@/lib/entityLinks';
import { requestHref } from '@/lib/requestDisplay';
import { cn, FOCUS_RING } from '@/lib/utils';
import {
  costColumn,
  durationColumn,
  statusColumn,
  timeColumn,
  titleColumn,
  workflowColumn,
  workTitle,
} from './runColumns';

/**
 * Runs in a history list. The title opens the request panel (the run's
 * request, with its result and approvals); "Diagnostics" opens the full run
 * page. It is repeated on every row, so it shows only on hover or keyboard
 * focus within the row (always on touch). A run with no request goes straight
 * to diagnostics.
 */
export function RunsTable({
  className,
  isLoading,
  runs,
}: {
  className?: string;
  isLoading?: boolean;
  runs: WorkflowRunSummary[];
}) {
  return (
    <DataTable
      actions={(run) => (
        <Link
          aria-label={`Diagnostics for ${workTitle(run, 'Untitled run')}`}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-sm text-sm text-paper-400 underline-offset-2 hover:text-paper-100 hover:underline focus-visible:underline',
            FOCUS_RING
          )}
          href={runHref(run.id)}
        >
          Diagnostics
          <Icon name="chevronRight" size={14} />
        </Link>
      )}
      actionsLabel="Diagnostics"
      className={className}
      columns={[
        statusColumn<WorkflowRunSummary>(),
        titleColumn<WorkflowRunSummary>('Untitled run', (run) =>
          run.workRequest?.externalTicketId ? (
            <span className="font-mono text-paper-400">{run.workRequest.externalTicketId}</span>
          ) : null
        ),
        workflowColumn<WorkflowRunSummary>(),
        durationColumn<WorkflowRunSummary>(),
        costColumn<WorkflowRunSummary>(),
        timeColumn<WorkflowRunSummary>('Started', (run) => run.startedAt),
      ]}
      getRowId={(run) => run.id}
      isLoading={isLoading}
      loadingLabel="runs"
      rowHref={(run) => (run.workRequest ? requestHref(run.workRequest.id) : runHref(run.id))}
      rows={runs}
    />
  );
}
