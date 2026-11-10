'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { RepoShareAccess } from '@/components/repositories/RepoShareAccess';
import { Alert } from '@/components/ui/Alert';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { useSetRepoShares, useShareCandidates } from '@/hooks/useRepositories';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';

/**
 * Choose which further teams in the organization may see and launch on a
 * repository. The owning team keeps managing it — editing, schedules,
 * dependency edges and who it is shared with.
 */
export function ShareRepoModal({
  repo,
  onClose,
}: {
  repo: RepositorySummary;
  onClose: () => void;
}) {
  const candidates = useShareCandidates(repo.id, true);
  const save = useSetRepoShares(repo.id);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set((repo.shares ?? []).map((s) => s.team.id))
  );

  function toggle(teamId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(teamId)) {
        next.delete(teamId);
      } else {
        next.add(teamId);
      }
      return next;
    });
  }

  const [confirmingRemoveAll, setConfirmingRemoveAll] = useState(false);
  const currentlyShared = repo.shares?.length ?? 0;

  async function commit() {
    await save.mutateAsync([...selected]);
    onClose();
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    // Saving nothing selected removes access for every team it was shared with.
    if (selected.size === 0 && currentlyShared > 0) {
      setConfirmingRemoveAll(true);
      return;
    }
    await commit();
  }

  return (
    <Modal
      onClose={onClose}
      open
      subtitle={`Members of the teams you pick can see this repository and start runs on it. ${repo.team.name} keeps managing it, and runs keep its budget and settings.`}
      title={connectionLabel(repo)}
    >
      {currentlyShared > 0 && (
        <fieldset className="mb-5">
          <legend className="label-mono mb-1">Current access</legend>
          <RepoShareAccess
            onRevoked={(teamId) =>
              setSelected((current) => {
                const next = new Set(current);
                next.delete(teamId);
                return next;
              })
            }
            repo={repo}
          />
        </fieldset>
      )}
      <form className="space-y-5" onSubmit={(e) => void handleSave(e).catch(() => {})}>
        {candidates.isLoading && <SkeletonRows label="teams" rows={3} />}
        {candidates.isError && (
          <Alert>{errMsg(candidates.error, 'Could not load the teams.')}</Alert>
        )}
        {candidates.data && candidates.data.length === 0 && (
          <EmptyState
            bordered
            hint="Create another team in this organization to share the repository with it."
            icon="teams"
            title="No other teams to share with"
          />
        )}
        {candidates.data && candidates.data.length > 0 && (
          <fieldset>
            <legend className="label-mono mb-2">
              Teams to share with{' '}
              <span className="tabular font-normal text-paper-500">({selected.size} selected)</span>
            </legend>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-ink-500/70 bg-ink-900/40">
              {candidates.data.map((team) => (
                <Checkbox
                  checked={selected.has(team.id)}
                  className={`border-b border-ink-600 px-3 py-2.5 last:border-b-0 ${
                    selected.has(team.id) ? 'bg-accent-400/[0.06]' : 'hover:bg-ink-700/40'
                  }`}
                  disabled={save.isPending}
                  key={team.id}
                  label={<span className="text-paper-100">{team.name}</span>}
                  onChange={() => toggle(team.id)}
                />
              ))}
            </div>
          </fieldset>
        )}

        {save.isError && <Alert>{errMsg(save.error, 'Could not update sharing.')}</Alert>}
        <ModalFooter
          disabled={!candidates.data}
          isPending={save.isPending}
          onCancel={onClose}
          pendingLabel="Saving…"
          submitLabel="Save changes"
        />
      </form>
      {confirmingRemoveAll && (
        <ConfirmModal
          confirmLabel="Remove sharing"
          dangerous
          message={`This removes access for ${currentlyShared} team${currentlyShared === 1 ? '' : 's'}. Their members can no longer see this repository or start runs on it.`}
          onClose={() => setConfirmingRemoveAll(false)}
          onConfirm={() => commit().catch(() => {})}
          open
          title="Stop sharing this repository?"
        />
      )}
    </Modal>
  );
}
