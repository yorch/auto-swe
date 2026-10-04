'use client';

import Link from 'next/link';
import { EpicList } from '@/components/epics/EpicList';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useEpics } from '@/hooks/useEpics';
import { useHasRole } from '@/hooks/useHasRole';

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
        isFetching={epicsQuery.isFetching}
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
          <EpicList epics={epics} />
        )}
      </QueryBoundary>
    </div>
  );
}
