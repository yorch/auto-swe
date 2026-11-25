'use client';

import type { OrchestrationDetailDto } from '@auto-swe/shared/lib/orchestrationApi';
import { useState } from 'react';
import { StreamIndicator } from '@/components/orchestrations/StreamIndicator';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StatusBadge } from '@/components/ui/StatusBadge';
import {
  type OrchestrationStreamState,
  useCancelOrchestration,
  useEndOrchestration,
} from '@/hooks/useOrchestrations';
import {
  BUDGET_TIER_OPTIONS,
  describeOrchestrationError,
  isOrchestrationLive,
} from '@/lib/orchestration';
import { formatTotalCost } from '@/lib/utils';

function RepoState({ detail }: { detail: OrchestrationDetailDto }) {
  if (detail.repoId && detail.repoAttachedAt) {
    return (
      <span>
        <Badge tone="success">Attached</Badge>{' '}
        <span className="break-all font-mono text-xs">{detail.repoName ?? detail.repoId}</span>{' '}
        <RelativeTime className="text-paper-500" value={detail.repoAttachedAt} />
      </span>
    );
  }
  if (detail.repoId) {
    return (
      <span>
        <Badge tone="info">Repository-bound</Badge>{' '}
        <span className="break-all font-mono text-xs">{detail.repoName ?? detail.repoId}</span>
      </span>
    );
  }
  if (detail.pendingAttach) {
    return <Badge tone="warning">Repository requested</Badge>;
  }
  return <Badge tone="neutral">No repository (read-only)</Badge>;
}

/** The exact figures behind the percentage, for a hover. */
function tokenTitle(
  tokens: NonNullable<OrchestrationDetailDto['budget']>['tokens']
): string | undefined {
  if (!tokens) {
    return undefined;
  }
  return `${tokens.used.toLocaleString('en-US')} of ${tokens.cap.toLocaleString('en-US')} ${tokens.kind} tokens, the orchestrator and its agents together`;
}

/** Status, repository state, connections, spend, and the launcher's cancel and end. */
export function OrchestrationHeader({
  detail,
  stream = 'idle',
}: {
  detail: OrchestrationDetailDto;
  /** How updates arrive, shown beside the status while the orchestration is live. */
  stream?: OrchestrationStreamState;
}) {
  const cancel = useCancelOrchestration(detail.id);
  const end = useEndOrchestration(detail.id);
  const [confirm, setConfirm] = useState<'cancel' | 'emergency' | 'end' | null>(null);
  const live = isOrchestrationLive(detail.status);
  const showActions = detail.canControl && live;
  // An operator's emergency stop of a service principal's orchestration: a separate, labelled act
  // (the same cancel the launcher has), offered only to someone who is not its launcher.
  const showEmergency = detail.canEmergencyStop === true && !detail.canControl && live;
  const showLauncherOnly = !detail.canControl && !showEmergency && live;
  const action = confirm === 'end' ? end : cancel;
  const stopsAll = confirm === 'cancel' || confirm === 'emergency';
  const billing = detail.billing ?? null;
  const tier = detail.budget?.tier ?? detail.budgetTier;
  const tierLabel = BUDGET_TIER_OPTIONS.find((o) => o.value === tier)?.label ?? tier;
  const openConfirm = (which: 'cancel' | 'emergency' | 'end') => {
    // A refusal from an earlier attempt must not greet the next one.
    cancel.reset();
    end.reset();
    setConfirm(which);
  };

  return (
    <div className="space-y-4 rounded-xl border border-ink-400 bg-ink-700 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold leading-tight text-paper-50">
            {detail.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-paper-400">
            <StatusBadge status={detail.status} />
            <StreamIndicator state={stream} />
            <span>{detail.teamName ?? 'Unknown team'}</span>
            {detail.launchedByName && <span>Launched by {detail.launchedByName}</span>}
          </div>
        </div>
        {showEmergency && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => openConfirm('emergency')} variant="danger">
              Emergency stop (platform admin)
            </Button>
          </div>
        )}
        {showActions && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => openConfirm('end')} variant="secondary">
              End
            </Button>
            <Button onClick={() => openConfirm('cancel')} variant="danger">
              Cancel orchestration
            </Button>
          </div>
        )}
      </div>
      {showLauncherOnly && (
        <p className="text-sm text-paper-400">
          Only {detail.launchedByName ?? 'the launcher'} can end this orchestration.
        </p>
      )}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
        <div className="min-w-0">
          <dt className="label-mono">Repository</dt>
          <dd className="mt-1 text-paper-200">
            <RepoState detail={detail} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="label-mono">MCP connections</dt>
          <dd className="mt-1 break-words text-paper-200">
            {detail.connections.length === 0
              ? 'None'
              : detail.connections.map((c) => c.name ?? c.id).join(', ')}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="label-mono">Spend</dt>
          <dd className="mt-1 text-paper-200">
            <span className="font-medium">{formatTotalCost(detail.cost.totalUsd)}</span>{' '}
            <span className="text-paper-400">
              ({formatTotalCost(detail.cost.orchestratorUsd)} orchestrator
              {billing ? `, billed to ${billing.orchestratorTeamName ?? 'an unreported team'}` : ''}
              ; {formatTotalCost(detail.cost.childrenUsd)} agents
              {billing ? `, billed to ${billing.childrenTeamName ?? 'an unreported team'}` : ''})
            </span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="label-mono">Budget</dt>
          <dd className="mt-1 break-words text-paper-200">
            {detail.budget?.percentUsed != null ? (
              <span title={tokenTitle(detail.budget.tokens)}>
                {detail.budget.percentUsed}% of the {tierLabel} budget used
              </span>
            ) : (
              <span>{tierLabel} tier</span>
            )}
            {detail.budget?.monthlyRemainingUsd != null &&
              `, remaining ${formatTotalCost(detail.budget.monthlyRemainingUsd)} this month`}
          </dd>
        </div>
      </dl>
      <ConfirmModal
        confirmLabel={
          confirm === 'emergency'
            ? 'Emergency stop'
            : confirm === 'cancel'
              ? 'Cancel orchestration'
              : 'End orchestration'
        }
        dangerous={stopsAll}
        error={action.isError ? describeOrchestrationError(action.error) : undefined}
        message={
          confirm === 'emergency'
            ? 'You are stopping an orchestration a service principal launched, as a platform admin. This stops every running agent; branches already pushed stay in place. The stop is recorded in the audit log under your name.'
            : confirm === 'cancel'
              ? 'This stops every running agent. Branches already pushed stay in place.'
              : 'This ends the conversation. You can start a new orchestration afterwards.'
        }
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await action.mutateAsync();
        }}
        open={confirm !== null}
        title={
          confirm === 'emergency'
            ? 'Emergency stop this orchestration?'
            : confirm === 'cancel'
              ? 'Cancel this orchestration?'
              : 'End this orchestration?'
        }
      />
    </div>
  );
}
