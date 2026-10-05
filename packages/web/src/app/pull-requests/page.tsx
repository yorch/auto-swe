'use client';

import { PULL_REQUEST_STATES, type PullRequestState } from '@auto-swe/shared/lib/pullRequest';
import { Suspense, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { PullRequestTable } from '@/components/work/PullRequestTable';
import { useRepositories } from '@/hooks/useRepositories';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { usePullRequests } from '@/hooks/useWorkViews';

const PAGE_SIZE = 30;
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
  const repoId = (params.get('repo') ?? '').slice(0, 64);
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

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="Pull requests the platform opened, with their state on the host, CI and the run behind them."
        title="Pull requests"
      />
      <Card variant="inset">
        <div className="flex flex-wrap items-end gap-4">
          <SegmentedControl
            ariaLabel="Pull request scope"
            onChange={(value) => update({ offset: null, scope: value })}
            options={[
              { label: 'My requests', value: 'MINE' },
              { label: 'Team requests', value: 'TEAM' },
            ]}
            value={scope}
          />
          <Select
            label="State"
            onChange={(value) => update({ offset: null, state: value === 'OPEN' ? null : value })}
            options={STATES}
            value={state}
          />
          <Select
            label="Draft"
            onChange={(value) => update({ draft: value === 'any' ? null : value, offset: null })}
            options={[...DRAFTS]}
            value={draft}
          />
          <Combobox
            label="Repository"
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
            value={repoId}
          />
          <div className="min-w-48 flex-1">
            <Input
              label="Ticket"
              maxLength={200}
              onChange={(event) => setTicketDraft(event.target.value)}
              placeholder="Ticket id…"
              value={ticketDraft}
            />
          </div>
        </div>
      </Card>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="pull requests"
        onRetry={() => void refetch()}
      >
        {pullRequests.length === 0 ? (
          <EmptyState
            hint={
              filtered
                ? 'Try another state or clear the filters.'
                : 'Pull requests the platform opens for your requests appear here.'
            }
            title={filtered ? 'No pull requests match these filters' : 'No open pull requests'}
          />
        ) : (
          <Card className="overflow-hidden p-0">
            <PullRequestTable pullRequests={pullRequests} />
          </Card>
        )}
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
      </QueryBoundary>
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
