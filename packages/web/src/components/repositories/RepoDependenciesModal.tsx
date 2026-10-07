'use client';

import { EDGE_KINDS } from '@auto-swe/shared/lib/repoDependency';
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useMemo, useState } from 'react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  type DepEdgeView,
  useCreateRepoDependency,
  useDeleteRepoDependency,
  useRepoDependencies,
  useSetRepoDependencyStatus,
} from '@/hooks/useRepoDependencies';
import { connectionLabel, repoRefLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';
import { formatPercent } from '@/lib/utils';

function neighborLabel(edge: DepEdgeView): string {
  if (edge.repo) {
    return repoRefLabel(edge.repo);
  }
  return edge.toRef ?? '(unknown)';
}

const EDGE_STATUS_TONE: Record<string, BadgeTone> = { active: 'moss', dismissed: 'brick' };

/** `92% confidence` for an LLM-inferred edge; nothing for a deterministic one. */
function ConfidenceNote({ edge }: { edge: DepEdgeView }) {
  if (edge.source !== 'inferred') {
    return null;
  }
  return <span> · {formatPercent(edge.confidence)} confidence</span>;
}

function EdgeRow({
  edge,
  canManage,
  canVeto,
  onConfirm,
  onDismiss,
  onReactivate,
  onRemove,
}: {
  edge: DepEdgeView;
  canManage: boolean;
  /**
   * Whether the confirm/dismiss/reactivate veto applies here. The veto
   * belongs to the depended-upon team, so it is offered only in the
   * "Depended on by" section (where the subject repo is the one being
   * depended on). In "Depends on" the subject is the dependent, whose
   * managers can only Remove.
   */
  canVeto: boolean;
  /** Confirm a `proposed` edge (an LLM-inferred suggestion awaiting review) straight to active. */
  onConfirm: () => void;
  onDismiss: () => void;
  onReactivate: () => void;
  onRemove: () => void;
}) {
  const items: ActionMenuItem[] = [];
  if (canManage && canVeto && edge.status === 'proposed') {
    items.push({ icon: 'check', id: 'confirm', label: 'Confirm', onAction: onConfirm });
  }
  if (canManage && canVeto && (edge.status === 'active' || edge.status === 'proposed')) {
    items.push({ icon: 'close', id: 'dismiss', label: 'Dismiss', onAction: onDismiss });
  }
  if (canManage && canVeto && edge.status === 'dismissed') {
    items.push({ icon: 'refresh', id: 'reactivate', label: 'Reactivate', onAction: onReactivate });
  }
  if (canManage) {
    items.push({
      icon: 'trash',
      id: 'remove',
      label: 'Remove',
      onAction: onRemove,
      tone: 'danger',
    });
  }
  const status = edge.status.charAt(0).toUpperCase() + edge.status.slice(1);
  return (
    <li className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm">
      <div className="min-w-0">
        <div className="truncate font-medium text-paper-100">{neighborLabel(edge)}</div>
        <div className="mt-0.5 text-xs text-paper-500">
          {edge.kind} · {edge.source}
          <ConfidenceNote edge={edge} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Badge tone={EDGE_STATUS_TONE[edge.status] ?? 'amber'} variant="outline">
          {status}
        </Badge>
        {items.length > 0 && (
          <ActionMenu items={items} label={`Actions for ${neighborLabel(edge)}`} />
        )}
      </div>
    </li>
  );
}

function DepSection({
  title,
  subtitle,
  edges,
  emptyText,
  canManage,
  canVeto,
  onDismiss,
  onReactivate,
  onRemove,
}: {
  title: string;
  subtitle?: string;
  edges: DepEdgeView[] | undefined;
  emptyText: string;
  canManage: boolean;
  canVeto: boolean;
  onDismiss: (id: string) => void;
  onReactivate: (id: string) => void;
  onRemove: (edge: DepEdgeView) => void;
}) {
  return (
    <section>
      <h4 className="font-semibold text-paper-100 text-sm">
        {title}
        {edges && edges.length > 0 && (
          <span className="tabular ml-2 font-normal text-paper-500">{edges.length}</span>
        )}
      </h4>
      {subtitle && <p className="mt-0.5 text-paper-500 text-xs">{subtitle}</p>}
      {edges && edges.length > 0 ? (
        <ul className="mt-2 divide-y divide-ink-600 rounded-lg border border-ink-500/70 bg-ink-900/40">
          {edges.map((e) => (
            <EdgeRow
              canManage={canManage}
              canVeto={canVeto}
              edge={e}
              key={e.id}
              // Confirming a `proposed` suggestion PATCHes the same
              // status:'active' as reactivating a dismissed edge — one hook,
              // one gate (both-teams LEAD, enforced server-side).
              onConfirm={() => onReactivate(e.id)}
              onDismiss={() => onDismiss(e.id)}
              onReactivate={() => onReactivate(e.id)}
              onRemove={() => onRemove(e)}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-2 rounded-lg border border-ink-500/60 border-dashed px-3.5 py-3 text-paper-500 text-[13px]">
          {emptyText}
        </p>
      )}
    </section>
  );
}

export function RepoDependenciesModal({
  repo,
  repos,
  canManage,
  canManageTeam,
  open,
  onClose,
}: {
  repo: RepositorySummary;
  repos: RepositorySummary[];
  /** The caller leads this repo's team (or is platform ADMIN). */
  canManage: boolean;
  /** Whether the caller leads `teamId` — a manual edge needs LEAD on both teams. */
  canManageTeam: (teamId: string | null | undefined) => boolean;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading, isError, error } = useRepoDependencies(repo.id, open);
  const create = useCreateRepoDependency(repo.id);
  const setStatus = useSetRepoDependencyStatus(repo.id);
  const remove = useDeleteRepoDependency(repo.id);

  const [toRepoId, setToRepoId] = useState('');
  const [kind, setKind] = useState('code');
  const [pendingRemove, setPendingRemove] = useState<{ id: string; label: string } | null>(null);

  const candidates = useMemo(
    () =>
      repos.filter(
        (r) =>
          (r.type ?? 'git_repo') === 'git_repo' && r.id !== repo.id && canManageTeam(r.team?.id)
      ),
    [repos, repo.id, canManageTeam]
  );

  const dismiss = (id: string) => setStatus.mutate({ edgeId: id, status: 'dismissed' });
  const reactivate = (id: string) => setStatus.mutate({ edgeId: id, status: 'active' });
  const requestRemove = (edge: DepEdgeView) =>
    setPendingRemove({ id: edge.id, label: neighborLabel(edge) });
  const mutationError = setStatus.error ?? remove.error;

  return (
    <>
      <Modal
        eyebrow="Repository dependencies"
        onClose={onClose}
        open={open}
        size="lg"
        subtitle="What this repository depends on, and what depends on it. Agents use these edges as context."
        title={connectionLabel(repo)}
      >
        {isLoading ? (
          <SkeletonRows rows={4} />
        ) : isError ? (
          <Alert>
            {errMsg(
              error,
              'Could not load dependencies — you may not have access to this repository.'
            )}
          </Alert>
        ) : (
          <div className="space-y-6">
            {mutationError && (
              <Alert>
                {errMsg(mutationError, 'That action didn’t go through — reopen and try again.')}
              </Alert>
            )}
            <DepSection
              canManage={canManage}
              canVeto={false}
              edges={data?.dependsOn}
              emptyText="No upstream dependencies."
              onDismiss={dismiss}
              onReactivate={reactivate}
              onRemove={requestRemove}
              title="Depends on"
            />
            <DepSection
              canManage={canManage}
              canVeto={true}
              edges={data?.dependedOnBy}
              emptyText="No downstream dependents."
              onDismiss={dismiss}
              onReactivate={reactivate}
              onRemove={requestRemove}
              subtitle="Repos that depend on this one. Dismiss here to opt this repo out as a context source."
              title="Depended on by"
            />

            {canManage && candidates.length > 0 && (
              <section className="border-ink-600 border-t pt-4">
                <h4 className="mb-3 font-semibold text-paper-100 text-sm">Add a dependency</h4>
                <div className="flex flex-wrap items-end gap-3">
                  <Combobox
                    className="min-w-56 flex-1"
                    label="This repo depends on"
                    onChange={setToRepoId}
                    options={candidates.map((r) => ({ label: connectionLabel(r), value: r.id }))}
                    placeholder="Select a repository…"
                    value={toRepoId}
                  />
                  <Select
                    label="Kind"
                    onChange={setKind}
                    options={EDGE_KINDS.map((k) => ({ label: k, value: k }))}
                    value={kind}
                  />
                  <Button
                    disabled={!toRepoId || create.isPending}
                    onClick={() =>
                      create.mutate({ kind, toRepoId }, { onSuccess: () => setToRepoId('') })
                    }
                    variant="primary"
                  >
                    <Icon name="plus" size={14} />
                    Add
                  </Button>
                </div>
                {create.isError && (
                  <Alert className="mt-2">
                    {errMsg(
                      create.error,
                      'Could not add — it may already exist, cross an org boundary, or you may lack LEAD on both teams.'
                    )}
                  </Alert>
                )}
              </section>
            )}
          </div>
        )}
        <ModalFooter cancelLabel="Close" onCancel={onClose} />
      </Modal>

      {pendingRemove && (
        <ConfirmModal
          confirmLabel="Remove"
          dangerous
          message={`Remove the dependency on ${pendingRemove.label}? This deletes the edge; it can be re-added later.`}
          onClose={() => setPendingRemove(null)}
          onConfirm={() => remove.mutate(pendingRemove.id)}
          open
          title="Remove dependency"
        />
      )}
    </>
  );
}
