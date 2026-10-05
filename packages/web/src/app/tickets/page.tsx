'use client';

import { Suspense, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
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
      <Card variant="inset">
        <div className="flex flex-wrap items-end gap-4">
          <SegmentedControl
            ariaLabel="Ticket scope"
            onChange={(value) => update({ offset: null, scope: value })}
            options={[
              { label: 'My requests', value: 'MINE' },
              { label: 'Team requests', value: 'TEAM' },
            ]}
            value={scope}
          />
          <div className="min-w-48 flex-1">
            <Input
              label="Search tickets"
              maxLength={200}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Ticket id or task…"
              value={searchDraft}
            />
          </div>
        </div>
        <Checkbox
          checked={!includeAutomated}
          className="mt-3"
          hint="Agent runs, channel tasks and launches that have no ticket of their own."
          label="Hide automated runs"
          onChange={(event) =>
            update({ automated: event.target.checked ? null : '1', offset: null })
          }
        />
      </Card>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="tickets"
        onRetry={() => void refetch()}
      >
        {groups.length === 0 ? (
          <EmptyState
            hint={
              search || includeAutomated
                ? 'Try another search.'
                : 'Work started with a ticket id appears here.'
            }
            title={search ? 'No tickets match this search' : 'No tickets yet'}
          />
        ) : (
          <Card className="overflow-hidden p-0">
            <TicketTable groups={groups} />
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

export default function TicketsPage() {
  return (
    <Suspense>
      <Tickets />
    </Suspense>
  );
}
