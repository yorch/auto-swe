'use client';

import { Suspense, useEffect, useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { TicketTable } from '@/components/work/TicketTable';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { useTickets } from '@/hooks/useWorkViews';

const PAGE_SIZE = 30;

function Tickets() {
  const { params, update } = useUrlFilters();
  const scope = params.get('scope') === 'TEAM' ? 'TEAM' : 'MINE';
  // Hidden unless asked for: agent runs, channel tasks and template launches file ids of their own.
  const includeAutomated = params.get('automated') === '1';
  const search = (params.get('search') ?? '').slice(0, 200);
  const offset = parseOffset(params.get('offset'));
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => setSearchDraft(search), [search]);
  useEffect(() => {
    if (searchDraft === search) {
      return;
    }
    const timer = setTimeout(() => update({ offset: null, search: searchDraft }), 300);
    return () => clearTimeout(timer);
  }, [searchDraft, search, update]);

  const { data, error, isError, isFetching, isLoading, meta, refetch } = useTickets({
    includeAutomated,
    limit: PAGE_SIZE,
    offset,
    scope,
    search: search || undefined,
  });
  const groups = data ?? [];
  const total = meta?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="Everything filed under one ticket: its requests, runs, pull requests and cost."
        title="Tickets"
      />
      <div className="space-y-4">
        <Card className="overflow-hidden p-0">
          <Toolbar
            className="mb-0 border-b border-ink-600 px-4 py-3"
            end={
              <SegmentedControl
                ariaLabel="Ticket scope"
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
              label="Search tickets"
              onChange={(value) => setSearchDraft(value.slice(0, 200))}
              placeholder="Ticket id or task…"
              value={searchDraft}
            />
            <Checkbox
              checked={!includeAutomated}
              className="px-1"
              label="Hide automated runs"
              onChange={(event) =>
                update({ automated: event.target.checked ? null : '1', offset: null })
              }
              title="Agent runs, channel tasks and launches that have no ticket of their own."
            />
          </Toolbar>
          {isLoading ? (
            <SkeletonRows className="px-4 py-4" rows={6} />
          ) : (
            <QueryBoundary
              error={error}
              isError={isError}
              isFetching={isFetching}
              isLoading={false}
              label="tickets"
              onRetry={() => void refetch()}
            >
              {groups.length === 0 ? (
                <EmptyState
                  action={
                    search ? (
                      <Button onClick={() => setSearchDraft('')} size="sm">
                        Clear search
                      </Button>
                    ) : (
                      <ButtonLink href="/start" size="sm" variant="secondary">
                        Start work
                      </ButtonLink>
                    )
                  }
                  hint={
                    search || includeAutomated
                      ? 'Try another search.'
                      : 'Work started with a ticket id appears here, grouped by ticket.'
                  }
                  icon={search ? 'search' : 'ticket'}
                  title={search ? 'No tickets match this search' : 'No tickets yet'}
                />
              ) : (
                <TicketTable groups={groups} />
              )}
            </QueryBoundary>
          )}
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

export default function TicketsPage() {
  return (
    <Suspense>
      <Tickets />
    </Suspense>
  );
}
