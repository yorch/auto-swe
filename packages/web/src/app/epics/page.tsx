'use client';

import { Suspense } from 'react';
import { EpicList } from '@/components/epics/EpicList';
import { TeamChip } from '@/components/teams/TeamChip';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Toolbar } from '@/components/ui/Toolbar';
import { useEpics } from '@/hooks/useEpics';
import { useHasRole } from '@/hooks/useHasRole';
import { useTeamParam } from '@/hooks/useTeamParam';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { teamGatedBoundary } from '@/lib/teamGate';
import { WORK_SCOPE_OPTIONS } from '@/lib/workScope';

const PAGE_SIZE = 30;

function Epics() {
  // Launching an epic requires LEAD.
  const canCreate = useHasRole('LEAD');
  const { params, update } = useUrlFilters();
  const scope = params.get('scope') === 'MINE' ? 'MINE' : 'TEAM';
  const offset = parseOffset(params.get('offset'));
  const teamFilter = useTeamParam();
  const epicsQuery = useEpics(
    { limit: PAGE_SIZE, offset, scope },
    { enabled: !teamFilter.blocked, teamId: teamFilter.teamId }
  );
  const epics = epicsQuery.data?.data ?? [];
  const total = epicsQuery.data?.meta.total ?? 0;

  return (
    <div className="space-y-6">
      <ButtonLink className="-ml-3" href="/requests" size="sm" variant="ghost">
        <Icon name="arrowLeft" size={14} />
        Requests
      </ButtonLink>
      <PageHeader
        actions={
          canCreate &&
          epics.length > 0 && (
            <ButtonLink href="/start?mode=epic" variant="primary">
              <Icon name="plus" size={14} />
              Start an epic
            </ButtonLink>
          )
        }
        help={
          <p>
            An epic <HelpTip term="epic" /> is a change that spans several repositories, split by
            the planner into ordered per-repository work.
          </p>
        }
        subtitle="Changes that span several repositories, split into per-repository work."
        title="Epics"
      />
      <TeamChip onRemove={teamFilter.clear} team={teamFilter.team} />

      <div className="space-y-4">
        <Toolbar
          className="mb-0"
          end={
            <SegmentedControl
              ariaLabel="Epic scope"
              onChange={(value) => update({ offset: null, scope: value })}
              options={WORK_SCOPE_OPTIONS}
              value={scope}
            />
          }
        />
        <QueryBoundary
          {...teamGatedBoundary(teamFilter, epicsQuery)}
          label="epics"
          loading={
            <Card className="px-5 py-3">
              <SkeletonRows label="epics" rows={5} />
            </Card>
          }
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
              bordered
              hint={
                scope === 'MINE'
                  ? 'You have not started any epics. Switch to “My team” to see epics your teammates started.'
                  : canCreate
                    ? 'Describe one change once and the planner fans it out across your repositories. For example: “Migrate auth /v1 to /v2 across 5 services” becomes one run per service, in dependency order, each ending in its own pull request for you to review.'
                    : 'A team lead or administrator can start one to fan work out across repositories.'
              }
              icon="epics"
              title={scope === 'MINE' ? 'None of your epics yet' : 'No epics yet'}
            />
          ) : (
            <EpicList epics={epics} />
          )}
        </QueryBoundary>
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

export default function EpicsPage() {
  return (
    <Suspense>
      <Epics />
    </Suspense>
  );
}
