'use client';

import type { WorkspaceRequestSummary } from '@auto-swe/shared/types/api';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { DataTable, type DataTableDensity } from '@/components/ui/DataTable';
import { Icon } from '@/components/ui/Icon';
import { attentionReasons, requestHref, requestProgress } from '@/lib/requestDisplay';
import { cn, FOCUS_RING } from '@/lib/utils';
import {
  costColumn,
  durationColumn,
  statusColumn,
  timeColumn,
  titleColumn,
  workflowColumn,
} from '../runs/runColumns';

const requestId = (request: WorkspaceRequestSummary) => request.workRequest?.id ?? request.id;

/**
 * Requests in the same column order as the run history: status, title (ticket
 * and progress beneath), workflow (target and attempts beneath), duration,
 * cost, last update. "Review pull request" is always visible: it is the action
 * a person came here to take.
 */
export function RequestList({
  density = 'comfortable',
  hrefFor = requestHref,
  requests,
}: {
  density?: DataTableDensity;
  requests: WorkspaceRequestSummary[];
  hrefFor?: (requestId: string) => string;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <DataTable
        actions={(request) =>
          request.reviewUrl ? (
            <a
              className={cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm text-sm font-medium text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
                FOCUS_RING
              )}
              href={request.reviewUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <Icon name="pullRequest" size={14} />
              Review pull request
              <Icon name="external" size={12} />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null
        }
        actionsLabel="Review"
        columns={[
          statusColumn<WorkspaceRequestSummary>(),
          titleColumn<WorkspaceRequestSummary>('Untitled request', (request) => {
            const reasons = attentionReasons(request);
            const ticket = request.workRequest?.externalTicketId;
            return (
              <>
                <div className="flex flex-wrap items-center gap-x-1.5">
                  {ticket && (
                    <>
                      <span className="font-mono text-paper-400">{ticket}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <span className="text-paper-400">{requestProgress(request)}</span>
                </div>
                {reasons.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {reasons.map((reason) => (
                      <Badge key={reason.label} tone={reason.tone} variant="outline">
                        {reason.label}
                      </Badge>
                    ))}
                  </div>
                )}
              </>
            );
          }),
          workflowColumn<WorkspaceRequestSummary>((request) => (
            <div className="mt-0.5 text-xs text-paper-500">
              <span className="text-paper-400">{request.target ?? 'No target connection'}</span>
              <span aria-hidden="true"> · </span>
              <span className="tabular">
                {request.attemptCount}{' '}
                {request.isCrossRepo
                  ? 'repository executions'
                  : request.attemptCount === 1
                    ? 'attempt'
                    : 'attempts'}
              </span>
            </div>
          )),
          durationColumn<WorkspaceRequestSummary>(),
          costColumn<WorkspaceRequestSummary>(),
          timeColumn<WorkspaceRequestSummary>(
            'Updated',
            (request) => request.endedAt ?? request.startedAt
          ),
        ]}
        density={density}
        getRowId={requestId}
        revealActions={false}
        rowHref={(request) => hrefFor(requestId(request))}
        rowScroll={false}
        rows={requests}
      />
    </Card>
  );
}
