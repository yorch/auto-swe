'use client';

import type { HumanStepSummary, TeamAttentionFailure } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import {
  useAssignFailure,
  useNudgeHumanStep,
  useTeamAttentionFailures,
  useTeamStaleApprovals,
} from '@/hooks/useTeamAttention';
import { useTeamOverview } from '@/hooks/useTeamOverview';
import { useTeam } from '@/hooks/useTeams';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { plural } from '@/lib/utils';

interface Member {
  id: string;
  label: string;
}

function BlockTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-1 text-sm font-medium text-paper-200">{children}</h4>;
}

/** One failure with no owner; Assign opens a chooser of the team's members. */
function FailureRow({
  failure,
  members,
  teamId,
}: {
  failure: TeamAttentionFailure;
  members: Member[] | undefined;
  teamId: string;
}) {
  const assign = useAssignFailure(teamId);
  const [choosing, setChoosing] = useState(false);
  const [assigneeId, setAssigneeId] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    try {
      await assign.mutateAsync({ assigneeId, runId: failure.runId });
    } catch (e) {
      setError(errMsg(e, 'Could not assign the failure.'));
    }
  }

  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0">
          <Link
            className="block truncate text-sm text-paper-100 underline-offset-2 hover:underline"
            href={`/runs/${encodeURIComponent(failure.runId)}`}
          >
            {failure.title}
          </Link>
          <span className="block text-xs text-paper-500">
            <span className="font-mono">{failure.repoName}</span>
            {' · failed '}
            <RelativeTime value={failure.failedAt} />
            {' · launched by '}
            {failure.formerLauncherName ?? 'a former member'}
          </span>
        </span>
        {members && !choosing && (
          <Button onClick={() => setChoosing(true)} size="sm" variant="secondary">
            Assign
          </Button>
        )}
        {members && choosing && (
          <span className="flex items-center gap-2">
            <select
              aria-label="Assign to"
              className="h-8 rounded-md border border-ink-200 bg-ink-900 px-2 text-sm text-paper-100"
              onChange={(e) => setAssigneeId(e.target.value)}
              value={assigneeId}
            >
              <option value="">Choose a member</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <Button
              disabled={assigneeId === '' || assign.isPending}
              onClick={() => void confirm()}
              size="sm"
              variant="primary"
            >
              Confirm
            </Button>
            <Button
              disabled={assign.isPending}
              onClick={() => {
                setChoosing(false);
                setError(null);
              }}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          </span>
        )}
      </div>
      {error && (
        <Alert className="mt-2" variant="error">
          {error}
        </Alert>
      )}
    </li>
  );
}

function nudgeError(e: unknown): string {
  if (e instanceof ApiError && e.status === 429) {
    return 'Already nudged in the last 4 hours.';
  }
  return errMsg(e, 'Could not send the nudge.');
}

/** One overdue pending step; Nudge shows only when its Slack announcement can be replied to. */
function StaleApprovalRow({ step }: { step: HumanStepSummary }) {
  const nudge = useNudgeHumanStep();
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setError(null);
    try {
      await nudge.mutateAsync(step.id);
    } catch (e) {
      setError(nudgeError(e));
    }
  }

  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-sm text-paper-100">{step.title}</span>
          {step.timeoutAt && (
            <span className="block text-xs text-paper-500">
              Overdue since <RelativeTime value={step.timeoutAt} />
            </span>
          )}
        </span>
        {step.hasSlackThread === true && (
          <span className="flex items-center gap-2">
            {nudge.data && (
              <span className="text-xs text-paper-500">
                <RelativeTime value={nudge.data.nudgedAt} />
              </span>
            )}
            <Button
              disabled={nudge.isPending || nudge.isSuccess}
              onClick={() => void send()}
              size="sm"
              variant="secondary"
            >
              {nudge.isSuccess ? 'Nudged' : 'Nudge'}
            </Button>
          </span>
        )}
      </div>
      {error && (
        <Alert className="mt-2" variant="error">
          {error}
        </Alert>
      )}
    </li>
  );
}

/**
 * What needs the lead's hand now: failures nobody owns, approvals past their deadline, and the
 * team's open pull requests. The first section of the Manage tab.
 */
export function TeamAttentionSection({ team }: { team: { id: string; slug: string } }) {
  const failures = useTeamAttentionFailures(team.id);
  const stale = useTeamStaleApprovals(team.id);
  const detail = useTeam(team.id);
  const overview = useTeamOverview(team.id);
  const members: Member[] | undefined = detail.data?.memberships.map((m) => ({
    id: m.user.id,
    label: m.user.email,
  }));
  const staleSteps = stale.data ?? [];
  const openPullRequests = overview.data?.lead?.openPullRequests;

  return (
    <Card data-testid="manage-attention">
      <CardHeader className="mb-2">
        <CardTitle>Attention</CardTitle>
      </CardHeader>
      <div className="space-y-5">
        <section>
          <BlockTitle>Failures with no owner</BlockTitle>
          <QueryBoundary
            error={failures.error}
            isError={failures.isError}
            isFetching={failures.isFetching}
            isLoading={failures.isLoading}
            label="failures"
            onRetry={() => void failures.refetch()}
          >
            {(failures.data ?? []).length === 0 ? (
              <p className="text-sm text-paper-400">No failures without an owner.</p>
            ) : (
              <ul className="divide-y divide-ink-600">
                {(failures.data ?? []).map((f) => (
                  <FailureRow failure={f} key={f.runId} members={members} teamId={team.id} />
                ))}
              </ul>
            )}
          </QueryBoundary>
        </section>

        <section>
          <BlockTitle>Stale approvals</BlockTitle>
          <QueryBoundary
            error={stale.error}
            isError={stale.isError}
            isFetching={stale.isFetching}
            isLoading={stale.isLoading}
            label="stale approvals"
            onRetry={() => void stale.refetch()}
          >
            {staleSteps.length === 0 ? (
              <p className="text-sm text-paper-400">No approvals are overdue.</p>
            ) : (
              <>
                <ul className="divide-y divide-ink-600">
                  {staleSteps.map((s) => (
                    <StaleApprovalRow key={s.id} step={s} />
                  ))}
                </ul>
                {staleSteps.some((s) => s.hasSlackThread === true) && (
                  <p className="mt-2 text-xs text-paper-500">Replies in the step's Slack thread.</p>
                )}
              </>
            )}
          </QueryBoundary>
        </section>

        {openPullRequests !== undefined && (
          <section>
            <BlockTitle>Open pull requests</BlockTitle>
            <Link
              className="text-sm text-paper-200 underline-offset-2 hover:underline"
              href={`/pull-requests?scope=TEAM&state=OPEN&team=${encodeURIComponent(team.slug)}`}
            >
              {plural(openPullRequests, 'open pull request')}
            </Link>
          </section>
        )}
      </div>
    </Card>
  );
}
