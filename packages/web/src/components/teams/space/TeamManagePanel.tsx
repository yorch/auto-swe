'use client';

import type { TeamSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { BudgetMeter } from '@/components/teams/BudgetMeter';
import { ServicePrincipalsSection } from '@/components/teams/ServicePrincipalsSection';
import { TeamAttentionSection } from '@/components/teams/space/TeamAttentionSection';
import { TeamAutomationsSection } from '@/components/teams/space/TeamAutomationsSection';
import { TeamBudgetRequestDialog } from '@/components/teams/space/TeamBudgetRequestDialog';
import { TeamSchedulesSection } from '@/components/teams/space/TeamSchedulesSection';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useCancelBudgetRequest, useMyTeamBudgetRequest } from '@/hooks/useTeamBudgetRequest';
import { useTeamOverview } from '@/hooks/useTeamOverview';
import { useTeam } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';
import { VIEW_ONLY_CHIP } from '@/lib/repoLaunch';
import { formatRelativeTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

function repoName(r: { organizationName: string; repoName: string }): string {
  return `${r.organizationName}/${r.repoName}`;
}

/** The team's owned repositories and the ones shared with it, with whether it may launch on them. */
function TeamRepositoriesSection({ team }: { team: TeamSummary }) {
  const { data, error, isError, isFetching, isLoading, refetch } = useTeam(team.id);
  const owned = data?.repositories ?? [];
  const shared = data?.sharedRepositories ?? [];
  return (
    <Card data-testid="manage-repositories">
      <CardHeader className="mb-2">
        <CardTitle>Repositories</CardTitle>
        <Link
          className="text-xs text-paper-300 underline-offset-2 hover:underline"
          href={`/teams/${encodeURIComponent(team.slug)}/settings`}
        >
          Sharing in Settings
        </Link>
      </CardHeader>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="repositories"
        onRetry={() => void refetch()}
      >
        {owned.length + shared.length === 0 ? (
          <EmptyState
            className="py-6"
            hint="Add one from Connections."
            icon="repositories"
            title="No repositories yet"
          />
        ) : (
          <ul className="divide-y divide-ink-600">
            {owned.map((r) => (
              <li className="flex items-center justify-between gap-3 py-2.5" key={r.id}>
                <span className="flex min-w-0 items-center gap-2">
                  <Icon className="shrink-0 text-paper-500" name="repositories" size={14} />
                  <span className="truncate font-mono text-sm text-paper-200">{repoName(r)}</span>
                </span>
                <Badge dot tone={r.isActive ? 'success' : 'muted'} variant="text">
                  {r.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </li>
            ))}
            {shared.map((r) => (
              <li className="flex items-center justify-between gap-3 py-2.5" key={r.id}>
                <span className="flex min-w-0 items-center gap-2">
                  <Icon className="shrink-0 text-paper-500" name="repositories" size={14} />
                  <span className="truncate font-mono text-sm text-paper-200">{repoName(r)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-paper-500">
                  {!r.canLaunch && (
                    <Badge tone="muted" variant="outline">
                      {VIEW_ONLY_CHIP}
                    </Badge>
                  )}
                  shared by {r.team.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Card>
  );
}

/** The team's budget meter; the editor lives in Settings, for those who may use it. */
function TeamBudgetPanel({
  canManageBudget,
  team,
}: {
  canManageBudget: boolean | null;
  team: TeamSummary;
}) {
  const { data, error, isError, isFetching, isLoading, refetch } = useTeamOverview(team.id);
  const [requesting, setRequesting] = useState(false);
  const trigger = useRef<HTMLSpanElement>(null);
  const pending = useMyTeamBudgetRequest(team.id, canManageBudget === false);
  const cancel = useCancelBudgetRequest(team.id);
  const request = pending.data ?? null;
  const sub = useAuthStore((s) => s.user?.sub ?? null);
  // The team has one pending request, whoever sent it; only its sender may withdraw it here.
  const ownRequest = !!request && request.requestedBy.id === sub;
  return (
    <Card data-testid="manage-budget">
      <CardHeader className="mb-2">
        <CardTitle>Budget</CardTitle>
        {canManageBudget && (
          <Link
            className="text-xs text-paper-300 underline-offset-2 hover:underline"
            href={`/teams/${encodeURIComponent(team.slug)}/settings?tab=budget`}
          >
            Manage budget
          </Link>
        )}
      </CardHeader>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="budget"
        onRetry={() => void refetch()}
      >
        {data?.budget ? (
          <BudgetMeter budget={data.budget} />
        ) : (
          <p className="text-sm text-paper-400">No budget limit applies to this team.</p>
        )}
        {canManageBudget === false && request && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-paper-400" data-testid="budget-request-pending">
              Budget change requested {formatRelativeTime(request.createdAt)}: {request.reason}. A
              team or organization admin decides this.
            </p>
            {ownRequest ? (
              <Button
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(request.id)}
                size="sm"
                variant="secondary"
              >
                Cancel request
              </Button>
            ) : (
              <p className="text-sm text-paper-400" data-testid="budget-request-requester">
                Requested by {request.requestedBy.name ?? 'a teammate'}; only they can cancel it.
              </p>
            )}
            {cancel.isError && (
              <p className="w-full text-sm text-danger-400" role="alert">
                {errMsg(cancel.error, 'Could not cancel the request.')}
              </p>
            )}
          </div>
        )}
        {canManageBudget === false && !request && !pending.isLoading && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-paper-400">Ask a team or organization admin to change it.</p>
            <span ref={trigger}>
              <Button onClick={() => setRequesting(true)} size="sm" variant="secondary">
                Request a change
              </Button>
            </span>
          </div>
        )}
      </QueryBoundary>
      {canManageBudget === false && (
        <TeamBudgetRequestDialog
          onClose={() => setRequesting(false)}
          open={requesting}
          returnFocus={() => trigger.current?.querySelector('button') ?? null}
          teamId={team.id}
        />
      )}
    </Card>
  );
}

/** Service principals need the team's repositories to scope a token to; they load their own. */
function TeamServicePrincipals({ team }: { team: TeamSummary }) {
  const { data, error, isError, isFetching, isLoading, refetch } = useTeam(team.id);
  return (
    <QueryBoundary
      error={error}
      isError={isError}
      isFetching={isFetching}
      isLoading={isLoading}
      label="service principals"
      onRetry={() => void refetch()}
    >
      <ServicePrincipalsSection
        repositories={[
          ...(data?.repositories ?? []).filter((r) => r.isActive),
          ...(data?.sharedRepositories ?? []),
        ].map((r) => ({ id: r.id, label: repoName(r) }))}
        teamId={team.id}
      />
    </QueryBoundary>
  );
}

/**
 * What a team's lead runs the team with: its repositories, schedules, automations, budget and
 * service principals, one section under the other. The tab is offered to a team LEAD or ADMIN and
 * a platform ADMIN only (`canSeeTeamManage`); the page enforces that, so every section here is
 * for a caller who may manage the team. Editing stays on the pages the sections open.
 */
export function TeamManagePanel({
  canManageBudget,
  team,
}: {
  /** Whether the caller may edit the team's budget cap; null while that is not yet known. */
  canManageBudget: boolean | null;
  team: TeamSummary;
}) {
  return (
    <div className="space-y-6">
      <TeamAttentionSection team={team} />
      <TeamRepositoriesSection team={team} />
      <TeamSchedulesSection team={team} />
      <TeamAutomationsSection team={team} />
      <TeamBudgetPanel canManageBudget={canManageBudget} team={team} />
      <TeamServicePrincipals team={team} />
    </div>
  );
}
