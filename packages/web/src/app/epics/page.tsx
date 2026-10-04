'use client';

import Link from 'next/link';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useEpics } from '@/hooks/useEpics';
import { useHasRole } from '@/hooks/useHasRole';
import { formatRelativeTime } from '@/lib/utils';

export default function EpicsPage() {
  // Launching an epic requires LEAD.
  const canCreate = useHasRole('LEAD');
  const epicsQuery = useEpics();
  const epics = epicsQuery.data?.data ?? [];

  return (
    <div className="space-y-6">
      <Link className="label-mono hover:text-paper-200" href="/workflows">
        ← Requests
      </Link>
      <PageHeader
        actions={
          canCreate && (
            <ButtonLink href="/start?mode=epic" variant="primary">
              Start an epic
            </ButtonLink>
          )
        }
        subtitle="Changes that span several repositories, split by the planner into ordered per-repository work."
        title="Epics"
      />

      <p className="text-sm text-paper-400">
        An epic breaks a brief into per-repository requests and runs them in dependency order.
        Single-repository changes belong in Requests; start them from Start work.
      </p>

      <QueryBoundary
        error={epicsQuery.error}
        isError={epicsQuery.isError}
        isLoading={epicsQuery.isLoading}
        label="epics"
        onRetry={() => void epicsQuery.refetch()}
      >
        {epics.length === 0 ? (
          <EmptyState
            action={
              canCreate ? (
                <ButtonLink href="/start?mode=epic" variant="primary">
                  Start an epic
                </ButtonLink>
              ) : undefined
            }
            hint="Start one to fan work out across repositories."
            title="No epics yet"
          />
        ) : (
          <Card className="overflow-hidden p-0">
            <ul className="divide-y divide-ink-600">
              {epics.map((epic) => (
                <li key={epic.workRequestId}>
                  <Link
                    className="block px-5 py-4 transition-colors hover:bg-ink-700 focus-visible:outline-2 focus-visible:outline-ember-400 focus-visible:-outline-offset-2"
                    href={`/epics/${encodeURIComponent(epic.epicWorkflowId)}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-ember-400">
                          {epic.externalTicketId}
                        </div>
                        <div className="mt-1 line-clamp-2 break-words text-sm text-paper-400">
                          {epic.description}
                        </div>
                      </div>
                      <StatusBadge status={epic.status} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-paper-400">
                      <span>
                        {epic.repoCount} {epic.repoCount === 1 ? 'repository' : 'repositories'}
                      </span>
                      <span>Created {formatRelativeTime(epic.createdAt)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </QueryBoundary>
    </div>
  );
}
