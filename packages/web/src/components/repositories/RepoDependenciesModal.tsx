'use client';

import { EDGE_KINDS } from '@auto-swe/shared/lib/repoDependency';
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  type DepEdgeView,
  useCreateRepoDependency,
  useDeleteRepoDependency,
  useRepoDependencies,
  useSetRepoDependencyStatus,
} from '@/hooks/useRepoDependencies';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';

function neighborLabel(edge: DepEdgeView): string {
  if (edge.repo) {
    const { organizationName, repoName, name } = edge.repo;
    if (organizationName && repoName) {
      return `${organizationName}/${repoName}`;
    }
    return name ?? edge.repo.id;
  }
  return edge.toRef ?? '(unknown)';
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'active'
      ? 'text-moss-400'
      : status === 'dismissed'
        ? 'text-brick-400'
        : 'text-amber-400';
  return (
    <span className={`font-mono text-[10px] uppercase tracking-wider ${color}`}>{status}</span>
  );
}

function EdgeRow({
  edge,
  canManage,
  canVeto,
  onDismiss,
  onReactivate,
  onRemove,
}: {
  edge: DepEdgeView;
  canManage: boolean;
  /**
   * Whether the dismiss/reactivate veto applies here. The veto belongs to the
   * depended-upon team, so it is offered only in the "Depended on by" section
   * (where the subject repo is the one being depended on). In "Depends on" the
   * subject is the dependent, whose managers can only Remove.
   */
  canVeto: boolean;
  onDismiss: () => void;
  onReactivate: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-2 border-ink-600 border-b py-1.5 text-sm">
      <div className="min-w-0">
        <span className="truncate font-medium">{neighborLabel(edge)}</span>
        <span className="ml-2 text-paper-400 text-xs">
          {edge.kind} · {edge.source}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge status={edge.status} />
        {canManage && canVeto && edge.status === 'active' && (
          <Button onClick={onDismiss} size="sm" variant="ghost">
            Dismiss
          </Button>
        )}
        {canManage && canVeto && edge.status === 'dismissed' && (
          <Button onClick={onReactivate} size="sm" variant="ghost">
            Reactivate
          </Button>
        )}
        {canManage && (
          <Button onClick={onRemove} size="sm" variant="ghost">
            Remove
          </Button>
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
      <h4 className="mb-1 font-semibold text-sm">{title}</h4>
      {subtitle && <p className="mb-1 text-paper-500 text-xs">{subtitle}</p>}
      {edges && edges.length > 0 ? (
        <ul>
          {edges.map((e) => (
            <EdgeRow
              canManage={canManage}
              canVeto={canVeto}
              edge={e}
              key={e.id}
              onDismiss={() => onDismiss(e.id)}
              onReactivate={() => onReactivate(e.id)}
              onRemove={() => onRemove(e)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-paper-400 text-sm">{emptyText}</p>
      )}
    </section>
  );
}

export function RepoDependenciesModal({
  repo,
  repos,
  canManage,
  open,
  onClose,
}: {
  repo: RepositorySummary;
  repos: RepositorySummary[];
  canManage: boolean;
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
    () => repos.filter((r) => (r.type ?? 'git_repo') === 'git_repo' && r.id !== repo.id),
    [repos, repo.id]
  );

  const dismiss = (id: string) => setStatus.mutate({ edgeId: id, status: 'dismissed' });
  const reactivate = (id: string) => setStatus.mutate({ edgeId: id, status: 'active' });
  const requestRemove = (edge: DepEdgeView) =>
    setPendingRemove({ id: edge.id, label: neighborLabel(edge) });
  const mutationError = setStatus.error ?? remove.error;

  return (
    <>
      <Modal
        onClose={onClose}
        open={open}
        size="lg"
        subtitle={connectionLabel(repo)}
        title="Dependencies"
      >
        {isLoading ? (
          <LoadingState message="Loading dependencies…" />
        ) : isError ? (
          <p className="py-6 text-center text-brick-400 text-sm">
            {errMsg(
              error,
              'Could not load dependencies — you may not have access to this repository.'
            )}
          </p>
        ) : (
          <div className="space-y-6">
            {mutationError && (
              <p className="rounded border border-brick-400/30 bg-brick-400/10 px-3 py-2 text-brick-400 text-xs">
                {errMsg(mutationError, 'That action didn’t go through — reopen and try again.')}
              </p>
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
                <h4 className="mb-2 font-semibold text-sm">Add a dependency</h4>
                <div className="flex items-end gap-2">
                  <Select
                    className="flex-1"
                    label="This repo depends on"
                    onChange={(e) => setToRepoId(e.target.value)}
                    value={toRepoId}
                  >
                    <option value="">Select a repository…</option>
                    {candidates.map((r) => (
                      <option key={r.id} value={r.id}>
                        {connectionLabel(r)}
                      </option>
                    ))}
                  </Select>
                  <Select label="Kind" onChange={(e) => setKind(e.target.value)} value={kind}>
                    {EDGE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </Select>
                  <Button
                    disabled={!toRepoId || create.isPending}
                    onClick={() =>
                      create.mutate({ kind, toRepoId }, { onSuccess: () => setToRepoId('') })
                    }
                    variant="primary"
                  >
                    Add
                  </Button>
                </div>
                {create.isError && (
                  <p className="mt-1 text-brick-400 text-xs">
                    {errMsg(
                      create.error,
                      'Could not add — it may already exist, cross an org boundary, or you may lack LEAD on both teams.'
                    )}
                  </p>
                )}
              </section>
            )}
          </div>
        )}
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
