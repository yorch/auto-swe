'use client';

import { use } from 'react';
import { CampaignCancel } from '@/components/campaigns/CampaignCancel';
import { CampaignTargets } from '@/components/campaigns/CampaignTargets';
import { campaignTicketId, recipeSummary } from '@/components/campaigns/campaignDisplay';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonDetail } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { isCampaignNotFound, isCampaignTerminal, useCampaign } from '@/hooks/useCampaigns';
import { useEntityTitle } from '@/hooks/useEntityTitle';
import { useRunsForWorkRequest } from '@/hooks/useRuns';
import { useLedTeamIds } from '@/hooks/useTeams';
import { usePullRequests } from '@/hooks/useWorkViews';
import { errMsg } from '@/lib/errors';
import { hasRole } from '@/lib/roles';
import { validateRouteParam } from '@/lib/routeParams';
import { useAuthStore } from '@/stores/authStore';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function CampaignDetailPage({ params }: PageProps) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const user = useAuthStore((s) => s.user);
  const ledTeamIds = useLedTeamIds();
  const { data: campaign, isLoading, error, refetch } = useCampaign(id ?? '');
  useEntityTitle(campaign?.name);
  // Every child run shares the campaign's work request, so its runs are found by that id and
  // matched to targets by Temporal workflow ID. 100 is the list endpoint's page cap.
  const { data: childRuns } = useRunsForWorkRequest(campaign?.workRequestId, 100);
  const runIdByWorkflowId = new Map((childRuns ?? []).map((r) => [r.workflowId, r.id]));
  // The review page of each opened draft, found by the campaign's ticket ID.
  const hasDrafts = (campaign?.counts.PR_OPENED ?? 0) > 0;
  const { data: pulls } = usePullRequests(
    {
      draft: 'any',
      limit: 100,
      offset: 0,
      scope: 'TEAM',
      state: 'all',
      ticket: campaign ? campaignTicketId(campaign.id) : undefined,
    },
    { enabled: hasDrafts }
  );
  const reviewIdByConnection = new Map(
    (pulls ?? []).flatMap((p) => (p.repository ? [[p.repository.id, p.id] as const] : []))
  );

  if (!id) {
    return <CampaignNotFound />;
  }
  if (isLoading) {
    return <SkeletonDetail label="campaign" />;
  }
  if (!campaign) {
    if (error && !isCampaignNotFound(error)) {
      return (
        <div className="space-y-6">
          <BackToCampaigns />
          <Alert
            action={
              <Button onClick={() => void refetch()} size="sm">
                Try again
              </Button>
            }
            title="Could not load this campaign"
          >
            {errMsg(error, `Could not load campaign ${id}`)}
          </Alert>
        </div>
      );
    }
    return <CampaignNotFound />;
  }

  const active = !isCampaignTerminal(campaign.state);
  // The gateway lets the creator, a LEAD or ADMIN of the owning team, and a platform ADMIN cancel.
  const canCancel =
    active &&
    (hasRole(user?.role, 'ADMIN') ||
      (!!user && campaign.createdBy?.id === user.sub) ||
      (ledTeamIds?.has(campaign.ownerTeam.id) ?? false));

  return (
    <div className="space-y-6">
      <BackToCampaigns />
      <PageHeader
        actions={
          canCancel && (
            <CampaignCancel campaignId={campaign.id} cancelling={campaign.state === 'CANCELLING'} />
          )
        }
        help={
          <p>
            A campaign applies one change to many repositories. Each repository below has its own
            run and ends in a draft pull request, nothing to change, or a failure with its reason.
          </p>
        }
        subtitle={recipeSummary(campaign.recipeRef, campaign.recipeParams)}
        title={campaign.name}
      />

      {campaign.state === 'CANCELLING' && (
        <Alert variant="info">
          Cancelling. Repositories not yet started will not start, and runs in flight are being
          asked to stop.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Brief</CardTitle>
            </CardHeader>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-paper-200">
              {campaign.description || <span className="text-paper-500">No description</span>}
            </p>
          </Card>
          <CampaignTargets
            campaign={campaign}
            reviewIdByConnection={reviewIdByConnection}
            runIdByWorkflowId={runIdByWorkflowId}
          />
        </div>

        <Card className="h-fit p-5" variant="inset">
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="label-mono">Status</dt>
              <dd className="mt-1">
                <StatusBadge status={campaign.state} />
              </dd>
            </div>
            <div>
              <dt className="label-mono">Owning team</dt>
              <dd className="mt-1 break-words text-paper-200">{campaign.ownerTeam.name}</dd>
            </div>
            {campaign.createdBy?.name && (
              <div>
                <dt className="label-mono">Started by</dt>
                <dd className="mt-1 break-words text-paper-200">{campaign.createdBy.name}</dd>
              </div>
            )}
            <div>
              <dt className="label-mono">Created</dt>
              <dd className="mt-1 text-paper-200">
                <RelativeTime value={campaign.createdAt} />
              </dd>
            </div>
            {campaign.completedAt && (
              <div>
                <dt className="label-mono">Finished</dt>
                <dd className="mt-1 text-paper-200">
                  <RelativeTime value={campaign.completedAt} />
                </dd>
              </div>
            )}
            <div>
              <dt className="label-mono">Parallel repositories</dt>
              <dd className="tabular mt-1 text-paper-200">{campaign.maxParallel}</dd>
            </div>
            <div>
              <dt className="label-mono">Campaign ID</dt>
              <dd className="mt-1 flex items-start gap-1">
                <span className="min-w-0 break-all font-mono text-xs text-paper-300">
                  {campaign.id}
                </span>
                <CopyButton value={campaign.id} />
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function BackToCampaigns() {
  return (
    <ButtonLink className="-ml-3" href="/campaigns" size="sm" variant="ghost">
      <Icon name="arrowLeft" size={14} />
      Campaigns
    </ButtonLink>
  );
}

function CampaignNotFound() {
  return (
    <EmptyState
      action={<ButtonLink href="/campaigns">Back to campaigns</ButtonLink>}
      bordered
      hint="It may not exist, you may not have access to it, or the link may be wrong."
      icon="epics"
      title="Campaign not found"
    />
  );
}
