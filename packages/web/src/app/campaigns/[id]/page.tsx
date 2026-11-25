'use client';

import { use } from 'react';
import { CampaignActions } from '@/components/campaigns/CampaignActions';
import { CampaignCancel } from '@/components/campaigns/CampaignCancel';
import { CampaignPlanReview } from '@/components/campaigns/CampaignPlanReview';
import { CampaignProposals } from '@/components/campaigns/CampaignProposals';
import { CampaignStateBadge } from '@/components/campaigns/CampaignStateBadge';
import { CampaignTargets } from '@/components/campaigns/CampaignTargets';
import {
  campaignTicketId,
  GATE_LABELS,
  PAUSED_REASON_TEXT,
  PLAN_LABELS,
  recipeSummary,
  SCOPE_KIND_LABELS,
} from '@/components/campaigns/campaignDisplay';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonDetail } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { isCampaignNotFound, isCampaignTerminal, useCampaign } from '@/hooks/useCampaigns';
import { useCan } from '@/hooks/useCan';
import { useEntityTitle } from '@/hooks/useEntityTitle';
import { useRunsForWorkRequest } from '@/hooks/useRuns';
import { usePullRequests } from '@/hooks/useWorkViews';
import { errMsg } from '@/lib/errors';
import { validateRouteParam } from '@/lib/routeParams';
import { useAuthStore } from '@/stores/authStore';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function CampaignDetailPage({ params }: PageProps) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const user = useAuthStore((s) => s.user);
  const { data: campaign, isLoading, error, refetch } = useCampaign(id ?? '');
  const ownerTeamId = campaign?.ownerTeamId ?? campaign?.ownerTeam?.id;
  // Holding the capability on the owning team is what makes someone a lead there; an
  // administrator holds it everywhere. The gateway decides every action regardless.
  const leadsOwnerTeam = useCan('team.launch.multi-repo', { teamId: ownerTeamId });
  useEntityTitle(campaign?.name);
  // Every child run shares the campaign's work request, so its runs are found by that id and
  // matched to targets by Temporal workflow ID. 100 is the list endpoint's page cap.
  const { data: childRuns } = useRunsForWorkRequest(campaign?.workRequestId, 100);
  const runIdByWorkflowId = new Map((childRuns ?? []).map((r) => [r.workflowId, r.id]));
  // The review page of each opened draft, found by the campaign's ticket ID.
  const hasDrafts = (campaign?.counts.prOpened ?? 0) + (campaign?.counts.merged ?? 0) > 0;
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
  const creatorId = campaign.createdById ?? campaign.createdBy?.id ?? null;
  const launcherId = campaign.launchedById ?? creatorId;
  const isCreator = !!user && creatorId === user.sub;
  const isLauncher = !!user && launcherId === user.sub;
  // The gateway lets the creator and whoever holds `team.launch.multi-repo` on the owning team
  // cancel, pause, resume, retry and remove; take-over is a lead's, never the current launcher's.
  const canManage = active && (leadsOwnerTeam || isCreator);
  const canCancel = canManage;
  const tracked = campaign.workflowKind === 'RECONCILER';

  return (
    <div className="space-y-6">
      <BackToCampaigns />
      <PageHeader
        actions={
          <>
            {tracked && (
              <CampaignActions
                campaign={campaign}
                canManage={canManage}
                canTakeOver={active && leadsOwnerTeam && !isLauncher}
              />
            )}
            {canCancel && (
              <CampaignCancel
                campaignId={campaign.id}
                cancelling={campaign.state === 'CANCELLING'}
              />
            )}
          </>
        }
        help={
          <p>
            A campaign pursues one goal across many repositories. Each repository below has its own
            run and ends in a draft pull request, or is already satisfied, or needs a person. It
            counts as satisfied when the recipe’s check passes on the base branch.
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
      {campaign.state === 'PAUSED' && (
        <Alert title="This campaign is paused" variant="warning">
          {campaign.pausedReason
            ? PAUSED_REASON_TEXT[campaign.pausedReason]
            : 'No repository starts until it is resumed.'}
        </Alert>
      )}
      {campaign.state === 'MONITORING' && (
        <Alert title="Monitoring" variant="info">
          Every known repository satisfies the goal. The campaign keeps checking
          {campaign.rescanIntervalHours ? ` every ${campaign.rescanIntervalHours} hours` : ''} and
          takes up any repository that starts to match
          {campaign.expiresAt ? (
            <>
              {' '}
              until it ends <RelativeTime value={campaign.expiresAt} />
            </>
          ) : null}
          .
        </Alert>
      )}
      {campaign.state === 'PLANNING' && !campaign.planFailure && (
        <Alert title="Awaiting confirmation" variant="info">
          The planner has written the work below. Nothing starts until the person who started this
          campaign confirms it.
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
          <CampaignProposals
            hiddenCount={campaign.hiddenProposalCount ?? 0}
            proposals={campaign.proposals ?? []}
          />
          {campaign.state === 'PLANNING' ? (
            <CampaignPlanReview campaign={campaign} isLauncher={isLauncher} />
          ) : (
            <CampaignTargets
              campaign={campaign}
              canManage={canManage}
              reviewIdByConnection={reviewIdByConnection}
              runIdByWorkflowId={runIdByWorkflowId}
            />
          )}
        </div>

        <Card className="h-fit p-5" variant="inset">
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="label-mono">Status</dt>
              <dd className="mt-1">
                <CampaignStateBadge state={campaign.state} />
              </dd>
            </div>
            <div>
              <dt className="label-mono">Work</dt>
              <dd className="mt-1 text-paper-200">{PLAN_LABELS[campaign.plan]}</dd>
            </div>
            {campaign.ownerTeam?.name && (
              <div>
                <dt className="label-mono">Owning team</dt>
                <dd className="mt-1 break-words text-paper-200">{campaign.ownerTeam.name}</dd>
              </div>
            )}
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
            {campaign.plan === 'PLANNED' && (
              <div>
                <dt className="label-mono">A repository starts when</dt>
                <dd className="mt-1 text-paper-200">{GATE_LABELS[campaign.gate]}</dd>
              </div>
            )}
            {!!campaign.maxOpenPullRequests && (
              <div>
                <dt className="label-mono">Open pull requests at most</dt>
                <dd className="tabular mt-1 text-paper-200">{campaign.maxOpenPullRequests}</dd>
              </div>
            )}
            {!!campaign.staleAfterDays && (
              <div>
                <dt className="label-mono">Stale after</dt>
                <dd className="tabular mt-1 text-paper-200">{campaign.staleAfterDays} days</dd>
              </div>
            )}
            {campaign.scopeKind && (
              <div>
                <dt className="label-mono">Looks for repositories in</dt>
                <dd className="mt-1 text-paper-200">{SCOPE_KIND_LABELS[campaign.scopeKind]}</dd>
              </div>
            )}
            {!!campaign.rescanIntervalHours && (
              <div>
                <dt className="label-mono">Re-checks every</dt>
                <dd className="tabular mt-1 text-paper-200">
                  {campaign.rescanIntervalHours} hours
                </dd>
              </div>
            )}
            {!!campaign.budgetUsd && (
              <div>
                <dt className="label-mono">Monthly budget</dt>
                <dd className="tabular mt-1 text-paper-200">
                  ${campaign.budgetUsd.toLocaleString('en-US')}
                </dd>
              </div>
            )}
            {campaign.expiresAt && (
              <div>
                <dt className="label-mono">Ends</dt>
                <dd className="mt-1 text-paper-200">
                  <RelativeTime value={campaign.expiresAt} />
                </dd>
              </div>
            )}
            {campaign.launcherChangedAt && (
              <div>
                <dt className="label-mono">Taken over</dt>
                <dd className="mt-1 text-paper-200">
                  <RelativeTime value={campaign.launcherChangedAt} />
                </dd>
              </div>
            )}
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
