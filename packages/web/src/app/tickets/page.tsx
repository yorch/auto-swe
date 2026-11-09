'use client';

import { Suspense } from 'react';
import { TeamChip } from '@/components/teams/TeamChip';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { TicketTable } from '@/components/work/TicketTable';
import { useDebouncedUrlSearch } from '@/hooks/useDebouncedUrlSearch';
import { useTeamParam } from '@/hooks/useTeamParam';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { useTickets } from '@/hooks/useWorkViews';
import { teamGatedBoundary } from '@/lib/teamGate';
import { WORK_SCOPE_OPTIONS } from '@/lib/workScope';

const PAGE_SIZE = 30;

function Tickets() {
  const { params, update } = useUrlFilters();
  const scope = params.get('scope') === 'TEAM' ? 'TEAM' : 'MINE';
  // Hidden unless asked for: agent runs, channel tasks and template launches file ids of their own.
  const includeAutomated = params.get('automated') === '1';
  const search = (params.get('search') ?? '').slice(0, 200);
  const offset = parseOffset(params.get('offset'));
  const [searchDraft, setSearchDraft] = useDebouncedUrlSearch(search, (value) =>
    update({ offset: null, search: value })
  );

  const teamFilter = useTeamParam();
  const { data, error, isError, isFetching, isLoading, meta, refetch } = useTickets(
    {
      includeAutomated,
      limit: PAGE_SIZE,
      offset,
      scope,
      search: search || undefined,
    },
    { enabled: !teamFilter.blocked, teamId: teamFilter.teamId }
  );
  const groups = data ?? [];
  const total = meta?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        help={
          <p>
            A ticket <HelpTip term="ticket" /> id is the label work is filed under: usually your
            tracker’s issue key, or a generated id when none was given.
          </p>
        }
        subtitle="Everything filed under one ticket: its requests, runs, pull requests and cost."
        title="Tickets"
      />
      <TeamChip onRemove={teamFilter.clear} team={teamFilter.team} />
      <div className="space-y-4">
        <Card className="overflow-hidden p-0">
          <Toolbar
            className="mb-0 border-b border-ink-600 px-4 py-3"
            end={
              <SegmentedControl
                ariaLabel="Ticket scope"
                onChange={(value) => update({ offset: null, scope: value })}
                options={WORK_SCOPE_OPTIONS}
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
            <span className="inline-flex items-center gap-1.5 px-1">
              <Checkbox
                checked={includeAutomated}
                label="Include automated runs"
                onChange={(event) =>
                  update({ automated: event.target.checked ? '1' : null, offset: null })
                }
              />
              <HelpTip label="Automated runs">
                Agent runs, channel tasks and template launches that have no ticket of their own.
                They are hidden unless this is checked.
              </HelpTip>
            </span>
          </Toolbar>
          <QueryBoundary
            {...teamGatedBoundary(teamFilter, { error, isError, isFetching, isLoading, refetch })}
            label="tickets"
            loading={<SkeletonRows className="px-4 py-4" label="tickets" rows={6} />}
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
                  search
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
