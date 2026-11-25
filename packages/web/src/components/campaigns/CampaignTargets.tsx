'use client';

import type { CampaignAttemptDto, CampaignTargetDto } from '@auto-swe/shared/lib/campaignApi';
import { normalizeTargetState } from '@auto-swe/shared/lib/campaignState';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { RelativeTime } from '@/components/ui/RelativeTime';
import {
  type CampaignDetail,
  useRemoveCampaignDependency,
  useRemoveCampaignTarget,
  useRetryCampaignTarget,
} from '@/hooks/useCampaigns';
import { safeHttpUrl } from '@/lib/safeUrl';
import { TargetStateBadge } from './CampaignStateBadge';
import {
  ATTEMPT_OUTCOME_LABELS,
  BLOCKED_KIND_LABELS,
  campaignHasCheck,
  campaignProgress,
  canRemoveTarget,
  canRetryTarget,
  groupTargets,
  latestAttempt,
  PATH_LABELS,
  PULL_REQUEST_STATUS_LABELS,
  targetAnchor,
  VERIFICATION_LABELS,
} from './campaignDisplay';
import { UpstreamNames } from './UpstreamNames';

/** What the check found, for the evidence kinds the reconciler writes; anything else is not shown. */
const EVIDENCE_LABELS: Record<string, string> = {
  'declared-at-target': 'The check passed: the repository declares the target version or later.',
  initial: 'Already satisfied before the campaign started.',
  'not-declared': 'The check passed: the repository does not declare the dependency.',
};

type PendingAction =
  | { kind: 'remove' | 'retry'; target: CampaignTargetDto }
  | { kind: 'dependency'; target: CampaignTargetDto; upstreamId: string; upstreamLabel: string };

/**
 * The per-repository state of a campaign, grouped by what the reader needs: what needs a person,
 * what waits for review, what is moving or blocked, what is satisfied, and what was dropped. A
 * target links to its latest run when the viewer can read it and to the platform's review page for
 * its draft pull request when one is known; the host's own link is the fallback. Retry and remove
 * are offered only when `canManage` (the gateway still decides, and its refusal shows in the dialog).
 */
export function CampaignTargets({
  campaign,
  canManage = false,
  reviewIdByConnection,
  runIdByWorkflowId,
}: {
  campaign: CampaignDetail;
  canManage?: boolean;
  reviewIdByConnection: ReadonlyMap<string, string>;
  runIdByWorkflowId: ReadonlyMap<string, string>;
}) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const retry = useRetryCampaignTarget(campaign.id);
  const remove = useRemoveCampaignTarget(campaign.id);
  const removeDependency = useRemoveCampaignDependency(campaign.id);
  const hasCheck = campaignHasCheck(campaign);
  const progress = campaignProgress(campaign.counts, { hasCheck });
  const groups = groupTargets(campaign.targets, { hasCheck });
  const labels = new Map(campaign.targets.map((t) => [t.id, t.repoLabel]));
  const planned = campaign.plan === 'PLANNED';
  const active =
    campaign.state === 'ACTIVE' || campaign.state === 'MONITORING' || campaign.state === 'PAUSED';
  const mayAct = canManage && active && campaign.workflowKind === 'RECONCILER';

  return (
    <Card className="overflow-hidden p-0">
      <CardHeader className="mb-0 px-5 pt-5 pb-3">
        <CardTitle>Repositories</CardTitle>
        <span className="tabular text-sm text-paper-400">
          {progress.done} of {progress.total} {hasCheck ? 'satisfied' : 'done'}
          {progress.needsAttention > 0 && ` · ${progress.needsAttention} need attention`}
        </span>
      </CardHeader>
      {progress.total > 0 && (
        <div className="px-5 pb-4">
          <div
            aria-label={hasCheck ? 'Repositories satisfied' : 'Repositories done'}
            aria-valuemax={progress.total}
            aria-valuemin={0}
            aria-valuenow={progress.done}
            className="h-1.5 w-full overflow-hidden rounded-full bg-ink-600"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-accent-400"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}
      {campaign.hiddenTargetCount > 0 && (
        <p className="px-5 pb-3 text-xs text-paper-500" data-testid="campaign-hidden-targets">
          {campaign.hiddenTargetCount}{' '}
          {campaign.hiddenTargetCount === 1 ? 'repository is' : 'repositories are'} not listed: you
          cannot reach {campaign.hiddenTargetCount === 1 ? 'it' : 'them'}. They count towards the
          totals.
        </p>
      )}
      {groups.length === 0 ? (
        <EmptyState
          hint="Repositories appear here as the campaign reaches them."
          icon="clock"
          title="No repositories to show"
        />
      ) : (
        groups.map((group) => (
          <section
            aria-labelledby={`campaign-group-${group.id}`}
            className="border-t border-ink-600"
            key={group.id}
          >
            <div className="px-5 pt-4 pb-2">
              <h4 className="text-sm font-medium text-paper-100" id={`campaign-group-${group.id}`}>
                {group.title}{' '}
                <span className="tabular text-paper-400">({group.targets.length})</span>
              </h4>
              <p className="text-xs text-paper-500">{group.hint}</p>
            </div>
            <ul className="divide-y divide-ink-600">
              {group.targets.map((target) => (
                <TargetRow
                  campaign={campaign}
                  key={target.id}
                  labels={labels}
                  onAct={mayAct ? (kind) => setPending({ kind, target }) : undefined}
                  onRemoveDependency={
                    mayAct
                      ? (upstreamId, upstreamLabel) =>
                          setPending({ kind: 'dependency', target, upstreamId, upstreamLabel })
                      : undefined
                  }
                  planned={planned}
                  reviewId={
                    target.connectionId ? reviewIdByConnection.get(target.connectionId) : undefined
                  }
                  runId={runIdFor(target, runIdByWorkflowId)}
                  target={target}
                />
              ))}
            </ul>
          </section>
        ))
      )}
      <ConfirmModal
        confirmLabel={
          pending?.kind === 'retry'
            ? 'Retry repository'
            : pending?.kind === 'dependency'
              ? 'Remove dependency'
              : 'Remove repository'
        }
        dangerous={pending?.kind === 'remove'}
        message={
          pending?.kind === 'dependency' ? (
            <p>
              <strong>{pending.target.repoLabel}</strong> will no longer wait for{' '}
              <strong>{pending.upstreamLabel}</strong>. It can start as soon as its other conditions
              are met, whether or not that repository has been reviewed or merged.
            </p>
          ) : pending?.kind === 'retry' ? (
            <p>
              Starts a new attempt in <strong>{pending.target.repoLabel}</strong> as the person this
              campaign runs as, on a new branch. Earlier attempts stay in its history.
            </p>
          ) : pending ? (
            <p>
              <strong>{pending.target.repoLabel}</strong> is taken out of the campaign and marked
              skipped. Nothing on the host is touched: a draft pull request already opened stays
              open for people to close.
            </p>
          ) : null
        }
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (!pending) {
            return;
          }
          if (pending.kind === 'dependency') {
            await removeDependency.mutateAsync({
              targetId: pending.target.id,
              upstreamId: pending.upstreamId,
            });
          } else if (pending.kind === 'retry') {
            await retry.mutateAsync(pending.target.id);
          } else {
            await remove.mutateAsync(pending.target.id);
          }
        }}
        open={pending !== null}
        pendingLabel={pending?.kind === 'retry' ? 'Retrying…' : 'Removing…'}
        title={
          pending?.kind === 'retry'
            ? 'Retry this repository?'
            : pending?.kind === 'dependency'
              ? 'Remove this dependency?'
              : 'Remove this repository?'
        }
      />
    </Card>
  );
}

/** The run page of the target's latest attempt, found by id or, for older rows, by workflow id. */
function runIdFor(
  target: CampaignTargetDto,
  runIdByWorkflowId: ReadonlyMap<string, string>
): string | undefined {
  const attempt = latestAttempt(target);
  if (attempt?.runId) {
    return attempt.runId;
  }
  const workflowId = attempt?.childWorkflowId ?? target.childWorkflowId;
  return workflowId ? runIdByWorkflowId.get(workflowId) : undefined;
}

function TargetRow({
  campaign,
  labels,
  onAct,
  onRemoveDependency,
  planned,
  reviewId,
  runId,
  target,
}: {
  campaign: CampaignDetail;
  labels: ReadonlyMap<string, string>;
  onAct?: (kind: 'remove' | 'retry') => void;
  onRemoveDependency?: (upstreamId: string, upstreamLabel: string) => void;
  planned: boolean;
  reviewId?: string;
  runId?: string;
  target: CampaignTargetDto;
}) {
  const state = normalizeTargetState(target.state);
  const evidenceKind =
    target.evidence && typeof target.evidence.kind === 'string' ? target.evidence.kind : null;
  const evidence = evidenceKind ? EVIDENCE_LABELS[evidenceKind] : undefined;
  const showFailure = target.failureReason && (state === 'NEEDS_ATTENTION' || state === 'SKIPPED');
  const attempts = [...target.attempts].sort((a, b) => a.n - b.n);
  return (
    <li className="px-5 py-3" id={targetAnchor(target.id)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-paper-100">
            {runId ? (
              <Link
                className="underline-offset-2 hover:underline"
                href={`/runs/${encodeURIComponent(runId)}`}
              >
                {target.repoLabel}
              </Link>
            ) : (
              target.repoLabel
            )}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <TargetStateBadge hasCheck={campaignHasCheck(campaign)} state={target.state} />
            {target.liveStatus && (
              <span className="text-xs text-paper-500">
                {target.liveStatus.replace(/_/g, ' ').toLowerCase()}
              </span>
            )}
          </div>
        </div>
        {onAct && (canRetryTarget(target) || canRemoveTarget(target)) && (
          <div className="flex shrink-0 gap-2">
            {canRetryTarget(target) && (
              <Button
                aria-label={`Retry ${target.repoLabel}`}
                onClick={() => onAct('retry')}
                size="sm"
              >
                Retry
              </Button>
            )}
            {canRemoveTarget(target) && (
              <Button
                aria-label={`Remove ${target.repoLabel}`}
                onClick={() => onAct('remove')}
                size="sm"
                variant="danger"
              >
                Remove
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="mt-2 space-y-1 text-xs text-paper-400">
        {target.blockedReason && (
          <p data-testid="blocked-reason">
            <span className="font-medium text-warning-400">
              {BLOCKED_KIND_LABELS[target.blockedReason.kind]}.
            </span>{' '}
            {target.blockedReason.text}
            {target.blockedReason.upstreamLabel &&
              !target.blockedReason.text.includes(target.blockedReason.upstreamLabel) && (
                <>
                  {' '}
                  Waits for{' '}
                  {target.blockedReason.upstreamId &&
                  labels.has(target.blockedReason.upstreamId) ? (
                    <a
                      className="text-paper-200 underline-offset-2 hover:underline"
                      href={`#${targetAnchor(target.blockedReason.upstreamId)}`}
                    >
                      {target.blockedReason.upstreamLabel}
                    </a>
                  ) : (
                    <span className="text-paper-200">{target.blockedReason.upstreamLabel}</span>
                  )}
                  .
                </>
              )}
          </p>
        )}
        {showFailure && <p className="break-words text-danger-400">{target.failureReason}</p>}
        <Delivery campaign={campaign} reviewId={reviewId} target={target} />
        {planned && target.dependsOn.length > 0 && (
          <p>
            Starts after <UpstreamNames labels={labels} linkable targetIds={target.dependsOn} />
          </p>
        )}
        {onRemoveDependency &&
          state === 'BLOCKED' &&
          target.blockedReason?.kind === 'waiting-upstream' && (
            <div className="flex flex-wrap gap-2 pt-1">
              {target.dependsOn.flatMap((upstreamId) => {
                const upstreamLabel = labels.get(upstreamId);
                return upstreamLabel
                  ? [
                      <Button
                        key={upstreamId}
                        onClick={() => onRemoveDependency(upstreamId, upstreamLabel)}
                        size="sm"
                      >
                        {`Remove dependency on ${upstreamLabel}`}
                      </Button>,
                    ]
                  : [];
              })}
            </div>
          )}
        {target.regressions > 0 && (
          <p>
            Regressed after being satisfied {target.regressions}{' '}
            {target.regressions === 1 ? 'time' : 'times'}.
          </p>
        )}
        {state === 'SATISFIED' && (evidence || target.lastCheckedAt) && (
          <p>
            {evidence}
            {evidence && target.lastCheckedAt ? ' ' : ''}
            {target.lastCheckedAt && (
              <>
                Last checked <RelativeTime value={target.lastCheckedAt} />.
              </>
            )}
          </p>
        )}
      </div>

      {(target.brief || attempts.length > 0) && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-paper-300">
            {attempts.length > 0
              ? `Attempts (${attempts.length})${target.brief ? ' and brief' : ''}`
              : 'Brief'}
          </summary>
          <div className="mt-2 space-y-3">
            {target.brief && (
              <p className="whitespace-pre-wrap break-words text-paper-300">{target.brief}</p>
            )}
            {attempts.length > 0 && (
              <ol className="space-y-2">
                {attempts.map((attempt) => (
                  <AttemptItem attempt={attempt} key={attempt.id} />
                ))}
              </ol>
            )}
          </div>
        </details>
      )}
    </li>
  );
}

function Delivery({
  campaign,
  reviewId,
  target,
}: {
  campaign: CampaignDetail;
  reviewId?: string;
  target: CampaignTargetDto;
}) {
  const delivery = target.delivery;
  const prNumber = delivery?.prNumber ?? target.prNumber;
  const hostUrl = safeHttpUrl(delivery?.prUrl ?? target.prUrl);
  if (prNumber === null && !hostUrl && !delivery) {
    return null;
  }
  const label = prNumber !== null ? `#${prNumber}` : 'Pull request';
  const details = [
    delivery?.status ? PULL_REQUEST_STATUS_LABELS[delivery.status] : null,
    delivery?.isDraft === true ? 'Draft' : delivery?.isDraft === false ? 'Ready for review' : null,
    delivery?.ciStatus ? `CI ${delivery.ciStatus.replace(/_/g, ' ').toLowerCase()}` : null,
  ].filter((part): part is string => part !== null);
  const openedAt = delivery?.openedAt ?? null;
  return (
    <p data-testid="delivery">
      {reviewId ? (
        <Link
          className="text-paper-100 underline-offset-2 hover:underline"
          href={`/pull-requests/${encodeURIComponent(reviewId)}`}
        >
          {label}
        </Link>
      ) : hostUrl ? (
        <a
          className="text-paper-100 underline-offset-2 hover:underline"
          href={hostUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          {label}
        </a>
      ) : (
        <span className="text-paper-100">{label}</span>
      )}
      {details.length > 0 && ` · ${details.join(' · ')}`}
      {openedAt && !delivery?.mergedAt && (
        <>
          {' '}
          · opened <RelativeTime value={openedAt} />
        </>
      )}
      {delivery?.mergedAt && (
        <>
          {' '}
          · merged <RelativeTime value={delivery.mergedAt} />
        </>
      )}
      {target.staleSince && (
        <span className="ml-2 font-medium text-warning-400">
          Stale: {openedAt ? 'open since ' : 'stale since '}
          <RelativeTime value={openedAt ?? target.staleSince} />
          {campaign.staleAfterDays ? ` (after ${campaign.staleAfterDays} days)` : ''}
        </span>
      )}
    </p>
  );
}

function AttemptItem({ attempt }: { attempt: CampaignAttemptDto }) {
  const summary = [
    attempt.outcome ? ATTEMPT_OUTCOME_LABELS[attempt.outcome] : 'In progress',
    attempt.path ? PATH_LABELS[attempt.path] : null,
    attempt.verification
      ? `Verification ${VERIFICATION_LABELS[attempt.verification].toLowerCase()}`
      : null,
  ].filter((part): part is string => part !== null);
  return (
    <li className="rounded-md border border-ink-600 px-3 py-2">
      <p className="text-paper-200">
        <span className="font-medium">Attempt {attempt.n}</span> · {summary.join(' · ')}
      </p>
      <p className="text-paper-500">
        Started <RelativeTime value={attempt.startedAt} />
        {attempt.finishedAt && (
          <>
            , finished <RelativeTime value={attempt.finishedAt} />
          </>
        )}
        {attempt.runId && (
          <>
            {' · '}
            <Link
              className="text-paper-300 underline-offset-2 hover:underline"
              href={`/runs/${encodeURIComponent(attempt.runId)}`}
            >
              View run
            </Link>
          </>
        )}
      </p>
      {attempt.failureReason && (
        <p className="mt-1 break-words text-danger-400">{attempt.failureReason}</p>
      )}
    </li>
  );
}
