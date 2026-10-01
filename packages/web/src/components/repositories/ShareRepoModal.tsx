'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
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

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await save.mutateAsync([...selected]);
    onClose();
  }

  return (
    <Modal
      eyebrow="§ Sharing"
      onClose={onClose}
      open
      subtitle={`Members of the teams you pick can see this repository and start runs on it. ${repo.team.name} keeps managing it, and runs keep its budget and settings.`}
      title={connectionLabel(repo)}
    >
      <form className="space-y-5" onSubmit={(e) => void handleSave(e).catch(() => {})}>
        {candidates.isLoading && <p className="text-sm text-paper-400">Loading teams…</p>}
        {candidates.isError && (
          <p className="text-sm text-brick-400">
            {errMsg(candidates.error, 'Could not load the teams.')}
          </p>
        )}
        {candidates.data && candidates.data.length === 0 && (
          <p className="text-sm text-paper-400">
            There are no other active teams in this organization.
          </p>
        )}
        {candidates.data && candidates.data.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="sr-only">Teams to share with</legend>
            {candidates.data.map((team) => (
              <label className="flex items-center gap-2 text-sm text-paper-200" key={team.id}>
                <input
                  checked={selected.has(team.id)}
                  disabled={save.isPending}
                  onChange={() => toggle(team.id)}
                  type="checkbox"
                />
                <span>{team.name}</span>
              </label>
            ))}
          </fieldset>
        )}

        {save.isError && (
          <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">
            {errMsg(save.error, 'Could not update sharing.')}
          </p>
        )}
        <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={save.isPending || !candidates.data} type="submit" variant="primary">
            {save.isPending ? 'Saving…' : 'Save sharing'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
