import type { WorkspaceRequestSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { requestHref, requestProgress } from '@/lib/requestDisplay';
import { formatRelativeTime } from '@/lib/utils';

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
        {requests.map((request) => (
          <li key={request.workRequest?.id ?? request.id}>
            <Link
              className="block px-5 py-4 transition-colors hover:bg-ink-700 focus-visible:outline-2 focus-visible:outline-ember-400 focus-visible:-outline-offset-2"
              href={hrefFor(request.workRequest?.id ?? request.id)}
              scroll={false}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 break-words text-sm font-semibold text-paper-100">
                    {request.workRequest?.title ||
                      request.workRequest?.description ||
                      request.workRequest?.externalTicketId ||
                      request.templateName ||
                      'Untitled request'}
                  </div>
                  <div className="mt-1 text-sm text-paper-400">{requestProgress(request)}</div>
                </div>
                <StatusBadge status={request.status} />
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-paper-400">
                <span>{request.target ?? 'No target connection'}</span>
                <span>{request.templateName}</span>
                <span>
                  {request.attemptCount}{' '}
                  {request.isCrossRepo
                    ? 'repository executions'
                    : request.attemptCount === 1
                      ? 'attempt'
                      : 'attempts'}
                </span>
                <span>Updated {formatRelativeTime(request.endedAt ?? request.startedAt)}</span>
              </div>
            </Link>
            {request.reviewUrl && (
              <a
                className="mx-5 mb-4 inline-block text-sm text-ember-400 hover:underline"
                href={request.reviewUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                Review pull request ↗
              </a>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
