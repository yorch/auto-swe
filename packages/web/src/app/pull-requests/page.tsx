'use client';

import { PULL_REQUEST_STATES, type PullRequestState } from '@auto-swe/shared/lib/pullRequest';
import { Suspense, useEffect, useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { PullRequestTable } from '@/components/work/PullRequestTable';
import { useRepositories } from '@/hooks/useRepositories';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { usePullRequests } from '@/hooks/useWorkViews';

const PAGE_SIZE = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StateFilter = PullRequestState | 'all';
const STATES: { label: string; value: StateFilter }[] = [
  { label: 'Open', value: 'OPEN' },
  { label: 'Merged', value: 'MERGED' },
  { label: 'Closed', value: 'CLOSED' },
  { label: 'All states', value: 'all' },
];
const DRAFTS = [
  { label: 'Drafts and ready', value: 'any' },
  { label: 'Drafts only', value: 'draft' },
  { label: 'Ready for review', value: 'ready' },
] as const;

function PullRequests() {
  const { params, update } = useUrlFilters();
  const scope = params.get('scope') === 'TEAM' ? 'TEAM' : 'MINE';
  // No parameter means "Open": the list a reviewer opens this page for.
  const rawState = params.get('state');
  const state: StateFilter =
    rawState === 'all' ? 'all' : (PULL_REQUEST_STATES.find((s) => s === rawState) ?? 'OPEN');
  const draft = DRAFTS.find((option) => option.value === params.get('draft'))?.value ?? 'any';
  // Only a uuid is sent: anything else in the address would just be a 400.
  const rawRepo = params.get('repo') ?? '';
  const repoId = UUID.test(rawRepo) ? rawRepo : '';
  const ticket = (params.get('ticket') ?? '').slice(0, 200);
  const offset = parseOffset(params.get('offset'));
  const [ticketDraft, setTicketDraft] = useState(ticket);
  useEffect(() => setTicketDraft(ticket), [ticket]);
  useEffect(() => {
    if (ticketDraft === ticket) {
      return;
    }
    const timer = setTimeout(() => update({ offset: null, ticket: ticketDraft }), 300);
    return () => clearTimeout(timer);
  }, [ticketDraft, ticket, update]);

  const { data: repositories = [] } = useRepositories({ limit: 100 });
  const { data, error, isError, isFetching, isLoading, meta, refetch } = usePullRequests({
    draft,
    limit: PAGE_SIZE,
    offset,
    repoId: repoId || undefined,
    scope,
    state,
    ticket: ticket || undefined,
  });
  const pullRequests = data ?? [];
  const total = meta?.total ?? 0;
  const filtered = state !== 'OPEN' || draft !== 'any' || repoId || ticket;

  const clearFilters = () => {
    setTicketDraft('');
    update({ draft: null, offset: null, repo: null, state: null, ticket: null });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="Pull requests the platform opened, with their state on the host, CI and the run behind them."
        title="Pull requests"
      />
      <div className="space-y-4">
        <Card className="overflow-hidden p-0">
          <Toolbar
            className="mb-0 border-b border-ink-600 px-4 py-3"
            end={
              <SegmentedControl
                ariaLabel="Pull request scope"
                onChange={(value) => update({ offset: null, scope: value })}
                options={[
                  { label: 'My requests', value: 'MINE' },
                  { label: 'Team requests', value: 'TEAM' },
                ]}
                value={scope}
              />
            }
          >
            <SearchInput
              label="Filter by ticket"
              onChange={(value) => setTicketDraft(value.slice(0, 200))}
              placeholder="Filter by ticket id…"
              value={ticketDraft}
            />
            <Select
              appearance="pill"
              aria-label="State"
              onChange={(value) => update({ offset: null, state: value === 'OPEN' ? null : value })}
              options={STATES}
              prefix="State:"
              value={state}
            />
            <Select
              appearance="pill"
              aria-label="Draft"
              onChange={(value) => update({ draft: value === 'any' ? null : value, offset: null })}
              options={[...DRAFTS]}
              value={draft}
            />
            <Combobox
              aria-label="Repository"
              className="w-full sm:w-56"
              compact
              onChange={(value) => update({ offset: null, repo: value })}
              options={[
                { label: 'All repositories', value: '' },
                ...repositories
                  .filter((repo) => repo.type === 'git_repo')
                  .map((repo) => ({
                    label: `${repo.organizationName}/${repo.repoName}`,
                    value: repo.id,
                  })),
              ]}
              placeholder="All repositories"
              value={repoId}
            />
            {filtered && (
              <Button onClick={clearFilters} size="sm" variant="ghost">
                Clear filters
              </Button>
            )}
          </Toolbar>
          <QueryBoundary
            error={error}
            isError={isError}
            isFetching={isFetching}
            isLoading={isLoading}
            label="pull requests"
            loading={<SkeletonRows className="px-4 py-4" rows={6} />}
            onRetry={() => void refetch()}
          >
            {pullRequests.length === 0 ? (
              <EmptyState
                action={
                  filtered ? (
                    <Button onClick={clearFilters} size="sm">
                      Clear filters
                    </Button>
                  ) : (
                    <ButtonLink href="/start" size="sm" variant="secondary">
                      Start work
                    </ButtonLink>
                  )
                }
                hint={
                  filtered
                    ? 'Try another state or clear the filters.'
                    : 'Pull requests the platform opens for your requests appear here, as drafts for you to review.'
                }
                icon={filtered ? 'search' : 'pullRequest'}
                title={filtered ? 'No pull requests match these filters' : 'No open pull requests'}
              />
            ) : (
              <PullRequestTable pullRequests={pullRequests} />
            )}
          </QueryBoundary>
        </Card>
        <Pagination
          hasNext={offset + PAGE_SIZE < total}
          hasPrev={offset > 0}
          onNext={() => update({ offset: String(offset + PAGE_SIZE) })}
          onPrev={() =>
            update({ offset: offset - PAGE_SIZE > 0 ? String(offset - PAGE_SIZE) : null })
          }
          rangeEnd={Math.min(offset + PAGE_SIZE, total)}
          rangeStart={total === 0 ? 0 : offset + 1}
          total={total}
        />
      </div>
    </div>
  );
}

export default function PullRequestsPage() {
  return (
    <Suspense>
      <PullRequests />
    </Suspense>
  );
}
