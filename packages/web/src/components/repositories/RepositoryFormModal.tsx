'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useCreateRepository, useTeams, useUpdateRepository } from '@/hooks/useWorkflows';

type Mode = { kind: 'create' } | { kind: 'edit'; repo: RepositorySummary };

export function RepositoryFormModal({
  open,
  onClose,
  mode,
}: {
  open: boolean;
  onClose: () => void;
  mode: Mode;
}) {
  const { data: teams = [] } = useTeams();
  const create = useCreateRepository();
  const update = useUpdateRepository(mode.kind === 'edit' ? mode.repo.id : '');

  const initial = mode.kind === 'edit' ? mode.repo : null;
  const [organizationName, setOrganizationName] = useState(initial?.organizationName ?? '');
  const [repoName, setRepoName] = useState(initial?.repoName ?? '');
  const [defaultBranch, setDefaultBranch] = useState(initial?.defaultBranch ?? 'main');
  const [teamId, setTeamId] = useState(initial?.team?.id ?? '');
  const [executorImage, setExecutorImage] = useState(initial?.executorImage ?? '');
  const [language, setLanguage] = useState(initial?.language ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [consolidationEnabled, setConsolidationEnabled] = useState(
    initial?.consolidationEnabled ?? true
  );
  const [error, setError] = useState<string | null>(null);

  // Reset form state from `initial` only when the modal opens — the previous
  // version also depended on `teams` so it re-ran every time the useTeams()
  // query resolved (or any parent re-render produced a new array identity)
  // and stomped user input.
  useEffect(() => {
    if (!open) {
      return;
    }
    setOrganizationName(initial?.organizationName ?? '');
    setRepoName(initial?.repoName ?? '');
    setDefaultBranch(initial?.defaultBranch ?? 'main');
    setExecutorImage(initial?.executorImage ?? '');
    setLanguage(initial?.language ?? '');
    setDescription(initial?.description ?? '');
    setIsActive(initial?.isActive ?? true);
    setConsolidationEnabled(initial?.consolidationEnabled ?? true);
    setError(null);
  }, [open, initial]);

  // Default-select the first team only when nothing is selected yet, so a
  // late-resolving useTeams() doesn't override an in-flight admin selection.
  useEffect(() => {
    if (!open) {
      return;
    }
    setTeamId((prev) => prev || initial?.team?.id || teams[0]?.id || '');
  }, [open, initial, teams]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (mode.kind === 'create') {
        await create.mutateAsync({
          defaultBranch,
          description: description.trim() || undefined,
          executorImage: executorImage.trim() || undefined,
          language: language.trim() || undefined,
          organizationName: organizationName.trim(),
          repoName: repoName.trim(),
          teamId,
        });
      } else {
        await update.mutateAsync({
          consolidationEnabled,
          defaultBranch,
          description: description.trim() || null,
          executorImage: executorImage.trim() || null,
          isActive,
          language: language.trim() || null,
          teamId,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save repository');
    }
  }

  const isEdit = mode.kind === 'edit';
  const busy = create.isPending || update.isPending;

  return (
    <Modal
      eyebrow={isEdit ? '§ Edit repository' : '§ Connect repository'}
      onClose={onClose}
      open={open}
      subtitle="auto-swe clones this repo into an ephemeral Docker container per work request and opens pull requests back here."
      title={isEdit ? `${initial?.organizationName}/${initial?.repoName}` : 'Add a repository'}
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        <div className="grid grid-cols-2 gap-3">
          <Input
            disabled={isEdit}
            label="Organization"
            onChange={(e) => setOrganizationName(e.target.value)}
            placeholder="acme"
            required
            value={organizationName}
          />
          <Input
            disabled={isEdit}
            label="Repo name"
            onChange={(e) => setRepoName(e.target.value)}
            placeholder="payments-api"
            required
            value={repoName}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Default branch"
            onChange={(e) => setDefaultBranch(e.target.value)}
            required
            value={defaultBranch}
          />
          <Select
            id="team"
            label="Team"
            onChange={(e) => setTeamId(e.target.value)}
            required
            value={teamId}
          >
            <option disabled value="">
              Select a team
            </option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        <Input
          hint="Docker image the worker spins up per run. Defaults to node:24-alpine if left blank."
          label="Executor image"
          onChange={(e) => setExecutorImage(e.target.value)}
          placeholder="node:24-alpine"
          value={executorImage}
        />
        <Input
          label="Language (optional)"
          onChange={(e) => setLanguage(e.target.value)}
          placeholder="typescript / python / ruby"
          value={language}
        />
        <Input
          label="Description (optional)"
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this repo does, for the agent's context"
          value={description}
        />
        {isEdit && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-paper-300">
              <input
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                type="checkbox"
              />
              <span>Active — accept new work requests for this repo</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-paper-300">
              <input
                checked={consolidationEnabled}
                onChange={(e) => setConsolidationEnabled(e.target.checked)}
                type="checkbox"
              />
              <span>Include in scheduled lesson consolidation</span>
            </label>
          </div>
        )}
        {error && (
          <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">{error}</p>
        )}
        <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy || !teamId} type="submit" variant="primary">
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add repository'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
