import type { WorkspaceRequestSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { RelativeTime } from '@/components/work/RelativeTime';
import { attentionReasons, requestHref, requestProgress } from '@/lib/requestDisplay';
import { cn, FOCUS_RING } from '@/lib/utils';

export function RequestList({
  requests,
  hrefFor = requestHref,
}: {
  requests: WorkspaceRequestSummary[];
  hrefFor?: (requestId: string) => string;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <ul className="divide-y divide-ink-600">
        {requests.map((request) => {
          const reasons = attentionReasons(request);
          return (
            <li key={request.workRequest?.id ?? request.id}>
              <Link
                className="block px-5 py-4 transition-colors hover:bg-ink-600/35 focus-visible:outline-2 focus-visible:outline-ember-400 focus-visible:-outline-offset-2"
                href={hrefFor(request.workRequest?.id ?? request.id)}
                scroll={false}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 break-words text-sm font-medium text-paper-100">
                      {request.workRequest?.title ||
                        request.workRequest?.description ||
                        request.workRequest?.externalTicketId ||
                        request.templateName ||
                        'Untitled request'}
                    </div>
                    <div className="mt-1 text-[13px] text-paper-400">
                      {requestProgress(request)}
                    </div>
                  </div>
                  <StatusBadge status={request.status} />
                </div>
                {reasons.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {reasons.map((reason) => (
                      <Badge key={reason.label} tone={reason.tone} variant="outline">
                        {reason.label}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-paper-500">
                  <span className="text-paper-400">{request.target ?? 'No target connection'}</span>
                  <span aria-hidden="true">·</span>
                  <span>{request.templateName}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular">
                    {request.attemptCount}{' '}
                    {request.isCrossRepo
                      ? 'repository executions'
                      : request.attemptCount === 1
                        ? 'attempt'
                        : 'attempts'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Updated <RelativeTime date={request.endedAt ?? request.startedAt} />
                  </span>
                </div>
              </Link>
              {request.reviewUrl && (
                <a
                  className={cn(
                    'mx-5 mb-4 inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-ember-400 hover:underline',
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
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
