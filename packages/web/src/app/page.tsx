'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { RequestList } from '@/components/requests/RequestList';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { type RequestScope, type RequestState, useRequests } from '@/hooks/useRequests';
import { deniedMessage } from '@/lib/accessDenied';

function WorkSection({
  title,
  state,
  scope,
  empty,
}: {
  title: string;
  state: RequestState;
  scope: RequestScope;
  empty: string;
}) {
  const query = useRequests({ limit: 5, scope, state });
  const requests = query.data?.data ?? [];
  return (
    <section>
      <SectionHeader
        actions={
          <Link
            className="text-sm text-ember-400 hover:underline"
            href={`/workflows?scope=${scope}&state=${state === 'success' ? 'finished' : state}`}
          >
            View all →
          </Link>
        }
        title={title}
      />
      <QueryBoundary
        error={query.error}
        isError={query.isError}
        isFetching={query.isFetching}
        isLoading={query.isLoading}
        label={title.toLowerCase()}
        onRetry={() => void query.refetch()}
      >
        {requests.length ? (
          <RequestList
            hrefFor={(id) => `/workflows?${new URLSearchParams({ request: id, scope }).toString()}`}
            requests={requests}
          />
        ) : (
          <EmptyState title={empty} />
        )}
      </QueryBoundary>
    </section>
  );
}

/** Why the user landed here, when a role-gated page sent them Home. */
function AccessDeniedNotice() {
  const params = useSearchParams();
  const message = deniedMessage(params.get('denied'), params.get('need'));
  return message ? <Alert variant="warning">{message}</Alert> : null;
}

export default function HomePage() {
  const [scope, setScope] = useState<RequestScope>('MINE');
  return (
    <div className="space-y-8">
      <Suspense fallback={null}>
        <AccessDeniedNotice />
      </Suspense>
      <PageHeader
        actions={
          <ButtonLink href="/start" variant="primary">
            Start work
          </ButtonLink>
        }
        subtitle="See what needs your attention, follow your work, and review the results."
        title="Home"
      />
      <SegmentedControl
        ariaLabel="Home scope"
        onChange={setScope}
        options={[
          { label: 'My work', value: 'MINE' },
          { label: 'Team work', value: 'TEAM' },
        ]}
        value={scope}
      />
      <WorkSection
        empty="No requests need attention right now."
        scope={scope}
        state="attention"
        title="Needs your attention"
      />
      <WorkSection
        empty="No work in progress. Start a workflow or give an agent a task."
        scope={scope}
        state="active"
        title="In progress"
      />
      <WorkSection
        empty="Finished work will appear here. Execution success still needs your review."
        scope={scope}
        state="success"
        title="Recent results"
      />
      <section className="rounded-xl border border-ink-400 bg-ink-700 p-6">
        <h2 className="text-lg font-semibold">Ready to start something?</h2>
        <p className="mt-2 text-sm text-paper-400">
          Run a workflow with defined checks and approvals, or give an agent a task on a repository.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <ButtonLink href="/start" variant="primary">
            Start work
          </ButtonLink>
          <ButtonLink href="/workflows/library">Browse workflows</ButtonLink>
        </div>
      </section>
    </div>
  );
}
