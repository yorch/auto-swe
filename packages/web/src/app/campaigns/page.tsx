'use client';

import { useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CampaignList } from '@/components/campaigns/CampaignList';
import { CampaignStartModal } from '@/components/campaigns/CampaignStartModal';
import { TeamChip } from '@/components/teams/TeamChip';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Toolbar } from '@/components/ui/Toolbar';
import { CAMPAIGN_STATES, type CampaignState, useCampaigns } from '@/hooks/useCampaigns';
import { useHasRole } from '@/hooks/useHasRole';
import { useTeamParam } from '@/hooks/useTeamParam';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { teamGatedBoundary } from '@/lib/teamGate';

const PAGE_SIZE = 30;

const STATE_OPTIONS = [
  { label: 'All states', value: '' },
  ...CAMPAIGN_STATES.map((s) => ({ label: s.replace(/_/g, ' ').toLowerCase(), value: s })),
];

function Campaigns() {
  const router = useRouter();
  // Starting a campaign requires the platform LEAD role (and LEAD on the owning team).
  const canStart = useHasRole('LEAD');
  const [starting, setStarting] = useState(false);
  const { params, update } = useUrlFilters();
  const stateParam = params.get('state');
  const state = CAMPAIGN_STATES.find((s) => s === stateParam) as CampaignState | undefined;
  const offset = parseOffset(params.get('offset'));
  const teamFilter = useTeamParam();
  const campaignsQuery = useCampaigns(
    { limit: PAGE_SIZE, offset, state },
    { enabled: !teamFilter.blocked, teamId: teamFilter.teamId }
  );
  const campaigns = campaignsQuery.data?.data ?? [];
  const total = campaignsQuery.data?.meta.total ?? 0;
  const startButton = canStart && (
    <Button onClick={() => setStarting(true)} variant="primary">
      <Icon name="plus" size={14} />
      Start a campaign
    </Button>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={campaigns.length > 0 && startButton}
        help={
          <p>
            A campaign applies one planned change to many repositories of one organization. Each
            repository gets its own run and ends in a draft pull request, nothing to change, or a
            failure with its reason. People review and merge every pull request.
          </p>
        }
        subtitle="One change applied across many repositories, with a draft pull request for each."
        title="Campaigns"
      />
      <TeamChip onRemove={teamFilter.clear} team={teamFilter.team} />

      <div className="space-y-4">
        <Toolbar
          className="mb-0"
          end={
            <Select
              appearance="pill"
              aria-label="Filter by state"
              onChange={(value) => update({ offset: null, state: value })}
              options={STATE_OPTIONS}
              prefix="state:"
              value={state ?? ''}
            />
          }
        />
        <QueryBoundary
          {...teamGatedBoundary(teamFilter, campaignsQuery)}
          label="campaigns"
          loading={
            <Card className="px-5 py-3">
              <SkeletonRows label="campaigns" rows={5} />
            </Card>
          }
        >
          {campaigns.length === 0 ? (
            <EmptyState
              action={canStart ? startButton : undefined}
              bordered
              hint={
                state
                  ? 'No campaign is in this state. Choose another state to see more.'
                  : canStart
                    ? 'Raise a dependency to a patched version, or describe a framework change, and the platform runs it in every repository you pick. Each repository ends in a draft pull request for you to review.'
                    : 'A team lead or administrator can start one to apply a change across repositories.'
              }
              icon="epics"
              title={state ? 'No campaigns in this state' : 'No campaigns yet'}
            />
          ) : (
            <CampaignList campaigns={campaigns} />
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
      {canStart && (
        <CampaignStartModal
          onClose={() => setStarting(false)}
          onStarted={(path) => {
            setStarting(false);
            router.push(path);
          }}
          open={starting}
        />
      )}
    </div>
  );
}

export default function CampaignsPage() {
  return (
    <Suspense>
      <Campaigns />
    </Suspense>
  );
}
