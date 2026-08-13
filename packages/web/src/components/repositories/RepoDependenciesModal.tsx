'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  type DepEdgeView,
  useCreateRepoDependency,
  useDeleteRepoDependency,
  useRepoDependencies,
  useSetRepoDependencyStatus,
} from '@/hooks/useRepoDependencies';

const KINDS = ['code', 'runtime', 'build', 'api', 'data'];

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
  onDismiss,
  onReactivate,
  onRemove,
}: {
  edge: DepEdgeView;
  canManage: boolean;
  onDismiss: () => void;
  onReactivate: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-2 border-paper-800 border-b py-1.5 text-sm">
      <div className="min-w-0">
        <span className="truncate font-medium">{neighborLabel(edge)}</span>
        <span className="ml-2 text-paper-400 text-xs">
          {edge.kind} · {edge.source}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge status={edge.status} />
        {canManage && edge.status === 'active' && (
          <Button onClick={onDismiss} size="sm" variant="ghost">
            Dismiss
          </Button>
        )}
        {canManage && edge.status === 'dismissed' && edge.repo && (
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
  const { data, isLoading } = useRepoDependencies(repo.id, open);
  const create = useCreateRepoDependency(repo.id);
  const setStatus = useSetRepoDependencyStatus(repo.id);
  const remove = useDeleteRepoDependency(repo.id);

  const [toRepoId, setToRepoId] = useState('');
  const [kind, setKind] = useState('code');

  const candidates = repos.filter((r) => (r.type ?? 'git_repo') === 'git_repo' && r.id !== repo.id);

  const label = repo.organizationName
    ? `${repo.organizationName}/${repo.repoName}`
    : (repo.name ?? repo.id);

  return (
    <Modal onClose={onClose} open={open} subtitle={label} title="Dependencies">
      {isLoading ? (
        <p className="py-6 text-center text-paper-400 text-sm">Loading…</p>
      ) : (
        <div className="space-y-6">
          <section>
            <h4 className="mb-1 font-semibold text-sm">Depends on</h4>
            {data && data.dependsOn.length > 0 ? (
              <ul>
                {data.dependsOn.map((e) => (
                  <EdgeRow
                    canManage={canManage}
                    edge={e}
                    key={e.id}
                    onDismiss={() => setStatus.mutate({ edgeId: e.id, status: 'dismissed' })}
                    onReactivate={() => setStatus.mutate({ edgeId: e.id, status: 'active' })}
                    onRemove={() => remove.mutate(e.id)}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-paper-400 text-sm">No upstream dependencies.</p>
            )}
          </section>

          <section>
            <h4 className="mb-1 font-semibold text-sm">Depended on by</h4>
            <p className="mb-1 text-paper-500 text-xs">
              Repos that depend on this one. Dismiss here to opt this repo out as a context source.
            </p>
            {data && data.dependedOnBy.length > 0 ? (
              <ul>
                {data.dependedOnBy.map((e) => (
                  <EdgeRow
                    canManage={canManage}
                    edge={e}
                    key={e.id}
                    onDismiss={() => setStatus.mutate({ edgeId: e.id, status: 'dismissed' })}
                    onReactivate={() => setStatus.mutate({ edgeId: e.id, status: 'active' })}
                    onRemove={() => remove.mutate(e.id)}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-paper-400 text-sm">No downstream dependents.</p>
            )}
          </section>

          {canManage && candidates.length > 0 && (
            <section className="border-paper-800 border-t pt-4">
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
                      {r.organizationName
                        ? `${r.organizationName}/${r.repoName}`
                        : (r.name ?? r.id)}
                    </option>
                  ))}
                </Select>
                <Select label="Kind" onChange={(e) => setKind(e.target.value)} value={kind}>
                  {KINDS.map((k) => (
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
                  Could not add — it may already exist, cross an org boundary, or you may lack LEAD
                  on both teams.
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
