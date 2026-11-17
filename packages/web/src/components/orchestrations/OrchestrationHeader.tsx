'use client';

import type { OrchestrationDetailDto } from '@auto-swe/shared/lib/orchestrationApi';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useCancelOrchestration, useEndOrchestration } from '@/hooks/useOrchestrations';
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

/** Status, repository state, connections, spend, and the launcher's cancel and end. */
export function OrchestrationHeader({ detail }: { detail: OrchestrationDetailDto }) {
  const cancel = useCancelOrchestration(detail.id);
  const end = useEndOrchestration(detail.id);
  const [confirm, setConfirm] = useState<'cancel' | 'end' | null>(null);
  const live = isOrchestrationLive(detail.status);
  const showActions = detail.canControl && live;
  const action = confirm === 'cancel' ? cancel : end;
  const billing = detail.billing ?? null;
  const tier = detail.budget?.tier ?? detail.budgetTier;
  const tierLabel = BUDGET_TIER_OPTIONS.find((o) => o.value === tier)?.label ?? tier;
  const openConfirm = (which: 'cancel' | 'end') => {
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
            <span>{detail.teamName ?? 'Unknown team'}</span>
            {detail.launchedByName && <span>Launched by {detail.launchedByName}</span>}
          </div>
        </div>
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
            {tierLabel} tier
            {detail.budget &&
              (detail.budget.remainingUsd === null
                ? ', remaining budget not reported'
                : `, ${formatTotalCost(detail.budget.remainingUsd)} remaining`)}
          </dd>
        </div>
      </dl>
      <ConfirmModal
        confirmLabel={confirm === 'cancel' ? 'Cancel orchestration' : 'End orchestration'}
        dangerous={confirm === 'cancel'}
        error={action.isError ? describeOrchestrationError(action.error) : undefined}
        message={
          confirm === 'cancel'
            ? 'This stops every running agent. Branches already pushed stay in place.'
            : 'This ends the conversation. You can start a new orchestration afterwards.'
        }
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await action.mutateAsync();
        }}
        open={confirm !== null}
        title={confirm === 'cancel' ? 'Cancel this orchestration?' : 'End this orchestration?'}
      />
    </div>
  );
}
