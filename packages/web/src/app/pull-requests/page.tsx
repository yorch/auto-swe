'use client';

import { PULL_REQUEST_STATES, type PullRequestState } from '@auto-swe/shared/lib/pullRequest';
import { Suspense } from 'react';
import { TeamChip } from '@/components/teams/TeamChip';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { PullRequestTable } from '@/components/work/PullRequestTable';
import { WorkScopeControl } from '@/components/work/WorkScopeControl';
import { useDebouncedUrlSearch } from '@/hooks/useDebouncedUrlSearch';
import { useRepositories } from '@/hooks/useRepositories';
import { useTeamParam } from '@/hooks/useTeamParam';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { usePullRequests } from '@/hooks/useWorkViews';
import { HELP_LINKS } from '@/lib/helpLinks';
import { teamGatedBoundary } from '@/lib/teamGate';

const PAGE_SIZE = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StateFilter = PullRequestState | 'all';
const STATES: { label: string; value: StateFilter }[] = [
  { label: 'Open', value: 'OPEN' },
  { label: 'Merged', value: 'MERGED' },
  { label: 'Closed', value: 'CLOSED' },
  { label: 'All states', value: 'all' },
];
// The repository filter loads one page of connections; a full page means there may be more.
const REPOSITORY_PAGE = 100;
const ORDERS = [
  { label: 'Newest first', value: 'newest' },
  { label: 'Needs attention first', value: 'attention' },
] as const;
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
  const order = params.get('order') === 'attention' ? 'attention' : 'newest';
  const draft = DRAFTS.find((option) => option.value === params.get('draft'))?.value ?? 'any';
  // Only a uuid is sent: anything else in the address would just be a 400.
  const rawRepo = params.get('repo') ?? '';
  const repoId = UUID.test(rawRepo) ? rawRepo : '';
  const ticket = (params.get('ticket') ?? '').slice(0, 200);
  const offset = parseOffset(params.get('offset'));
  const [ticketDraft, setTicketDraft] = useDebouncedUrlSearch(ticket, (value) =>
    update({ offset: null, ticket: value })
  );

  const { data: repositories = [] } = useRepositories({ limit: REPOSITORY_PAGE });
  const teamFilter = useTeamParam();
  const { data, error, isError, isFetching, isLoading, meta, refetch } = usePullRequests(
    {
      draft,
      limit: PAGE_SIZE,
      offset,
      // The queue covers open pull requests only, so it asks for exactly those.
      ...(order === 'attention' ? { order } : {}),
      repoId: repoId || undefined,
      scope,
      state: order === 'attention' ? 'OPEN' : state,
      ticket: ticket || undefined,
    },
    { enabled: !teamFilter.blocked, teamId: teamFilter.teamId }
  );
  const pullRequests = data ?? [];
  const total = meta?.total ?? 0;
  const filtered =
    scope !== 'MINE' ||
    state !== 'OPEN' ||
    draft !== 'any' ||
    repoId ||
    ticket ||
    order === 'attention';

  const clearFilters = () => {
    setTicketDraft('');
    update({
      draft: null,
      offset: null,
      order: null,
      repo: null,
      scope: null,
      state: null,
      ticket: null,
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        help={
          <>
            <p data-testid="never-merges-note">
              No built-in step or template merges a pull request; you review and merge it on the
              host.
            </p>
            <p>
              State is the pull request’s state on the host: Open, Draft (open but not yet asking
              for review), Merged or Closed. For an open pull request the CI badge is the latest
              check result the host reported; “pending” means no result yet.
            </p>
          </>
        }
        learnMore={HELP_LINKS.concepts}
        subtitle="Pull requests the platform opened, with their state on the host, CI and the run behind them."
        title="Pull requests"
      />
      <TeamChip onRemove={teamFilter.clear} team={teamFilter.team} />
      <div className="space-y-4">
        <Toolbar
          end={
            <WorkScopeControl
              label="Pull request scope"
              onChange={(value) => update({ offset: null, scope: value })}
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
            aria-label="Order"
            onChange={(value) => update({ offset: null, order: value === 'newest' ? null : value })}
            options={[...ORDERS]}
            prefix="Order:"
            value={order}
          />
          {order === 'newest' && (
            <Select
              appearance="pill"
              aria-label="State"
              onChange={(value) => update({ offset: null, state: value === 'OPEN' ? null : value })}
              options={STATES}
              prefix="State:"
              value={state}
            />
          )}
          <Select
            appearance="pill"
            aria-label="Draft"
            onChange={(value) => update({ draft: value === 'any' ? null : value, offset: null })}
            options={[...DRAFTS]}
            prefix="Draft:"
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
        <Card className="overflow-hidden p-0">
          {repositories.length >= REPOSITORY_PAGE && (
            <p className="border-b border-ink-600 px-4 py-2 text-xs text-paper-500">
              The repository filter lists the first {REPOSITORY_PAGE} repositories only.
            </p>
          )}
          <QueryBoundary
            {...teamGatedBoundary(teamFilter, { error, isError, isFetching, isLoading, refetch })}
            label="pull requests"
            loading={<SkeletonRows className="px-4 py-4" label="pull requests" rows={6} />}
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
                    : 'Pull requests the platform opens for your requests appear here for you to review.'
                }
                icon={filtered ? 'search' : 'pullRequest'}
                title={filtered ? 'No pull requests match these filters' : 'No open pull requests'}
              />
            ) : (
              <PullRequestTable ordered={order === 'attention'} pullRequests={pullRequests} />
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
