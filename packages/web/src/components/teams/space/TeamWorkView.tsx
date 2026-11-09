'use client';

import { useState } from 'react';
import { EpicList } from '@/components/epics/EpicList';
import { RequestList } from '@/components/requests/RequestList';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { PullRequestTable } from '@/components/work/PullRequestTable';
import { TicketTable } from '@/components/work/TicketTable';
import { useEpics } from '@/hooks/useEpics';
import { useRequests } from '@/hooks/useRequests';
import { usePullRequests, useTickets } from '@/hooks/useWorkViews';

const PAGE_SIZE = 20;
type View = 'requests' | 'pull-requests' | 'tickets' | 'epics';
const VIEWS: { label: string; value: View }[] = [
  { label: 'Requests', value: 'requests' },
  { label: 'Pull requests', value: 'pull-requests' },
  { label: 'Tickets', value: 'tickets' },
  { label: 'Epics', value: 'epics' },
];

/** The shape every list query here reduces to for the shared frame. */
interface ListState {
  error: unknown;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
  refetch: () => unknown;
  total: number;
  empty: boolean;
}

/**
 * One team's work: its requests, pull requests, tickets and epics, through the same hooks and
 * list components as the global pages, with the team taken from the route. Only the active
 * view's query is enabled.
 */
export function TeamWorkView({ teamId }: { teamId: string }) {
  const [view, setView] = useState<View>('requests');
  const [offset, setOffset] = useState(0);
  const pick = (next: View) => {
    setView(next);
    setOffset(0);
  };

  const requests = useRequests(
    { limit: PAGE_SIZE, offset, scope: 'TEAM', state: 'all' },
    { enabled: view === 'requests', teamId }
  );
  const pulls = usePullRequests(
    { draft: 'any', limit: PAGE_SIZE, offset, scope: 'TEAM', state: 'all' },
    { enabled: view === 'pull-requests', teamId }
  );
  const tickets = useTickets(
    { includeAutomated: false, limit: PAGE_SIZE, offset, scope: 'TEAM' },
    { enabled: view === 'tickets', teamId }
  );
  const epics = useEpics(
    { limit: PAGE_SIZE, offset, scope: 'TEAM' },
    { enabled: view === 'epics', teamId }
  );

  const states: Record<View, ListState> = {
    epics: {
      ...epics,
      empty: (epics.data?.data.length ?? 0) === 0,
      total: epics.data?.meta.total ?? 0,
    },
    'pull-requests': {
      ...pulls,
      empty: (pulls.data?.length ?? 0) === 0,
      total: pulls.meta?.total ?? 0,
    },
    requests: {
      ...requests,
      empty: (requests.data?.data.length ?? 0) === 0,
      total: requests.data?.meta.total ?? 0,
    },
    tickets: {
      ...tickets,
      empty: (tickets.data?.length ?? 0) === 0,
      total: tickets.meta?.total ?? 0,
    },
  };
  const active = states[view];
  const label = VIEWS.find((v) => v.value === view)?.label.toLowerCase() ?? 'work';

  return (
    <div className="space-y-4">
      <SegmentedControl ariaLabel="Kind of work" onChange={pick} options={VIEWS} value={view} />
      <QueryBoundary
        error={active.error}
        isError={active.isError}
        isFetching={active.isFetching}
        isLoading={active.isLoading}
        label={label}
        loading={
          <Card className="px-5 py-3">
            <SkeletonRows label={label} rows={6} />
          </Card>
        }
        onRetry={() => void active.refetch()}
      >
        {active.empty ? (
          <EmptyState
            bordered
            hint="Work on this team's repositories appears here."
            icon="inbox"
            title={`No ${label} yet`}
          />
        ) : view === 'requests' ? (
          <RequestList requests={requests.data?.data ?? []} viewerTeamId={teamId} />
        ) : view === 'pull-requests' ? (
          <Card className="overflow-hidden p-0">
            <PullRequestTable pullRequests={pulls.data ?? []} viewerTeamId={teamId} />
          </Card>
        ) : view === 'tickets' ? (
          <Card className="overflow-hidden p-0">
            <TicketTable groups={tickets.data ?? []} />
          </Card>
        ) : (
          <EpicList epics={epics.data?.data ?? []} />
        )}
        <Pagination
          hasNext={offset + PAGE_SIZE < active.total}
          hasPrev={offset > 0}
          onNext={() => setOffset(offset + PAGE_SIZE)}
          onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          rangeEnd={Math.min(offset + PAGE_SIZE, active.total)}
          rangeStart={active.total ? offset + 1 : 0}
          total={active.total}
        />
      </QueryBoundary>
    </div>
  );
}
