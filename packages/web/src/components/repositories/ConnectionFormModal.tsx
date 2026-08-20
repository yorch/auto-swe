'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useCreateRepository, useUpdateRepository } from '@/hooks/useRepositories';
import { useTeams } from '@/hooks/useTeams';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';

export interface ConnectionPrefill {
  organizationName?: string;
  repoName?: string;
  defaultBranch?: string;
  language?: string;
  description?: string;
  githubUrl?: string;
  githubApiUrl?: string;
}

type Mode =
  | { kind: 'create'; prefill?: ConnectionPrefill }
  | { kind: 'edit'; repo: RepositorySummary };

const CONNECTION_TYPES = [
  { label: 'Git repository (GitHub / GHE)', value: 'git_repo' },
  { label: 'REST API endpoint', value: 'api_endpoint' },
  { label: 'Generic / other', value: 'generic' },
] as const;

type ConnectionType = (typeof CONNECTION_TYPES)[number]['value'];

export function ConnectionFormModal({
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
  const prefill = mode.kind === 'create' ? mode.prefill : undefined;

  const [connType, setConnType] = useState<ConnectionType>(
    (initial?.type as ConnectionType) ?? 'git_repo'
  );

  // git_repo fields
  const [organizationName, setOrganizationName] = useState(
    initial?.organizationName ?? prefill?.organizationName ?? ''
  );
  const [repoName, setRepoName] = useState(initial?.repoName ?? prefill?.repoName ?? '');
  const [defaultBranch, setDefaultBranch] = useState(
    initial?.defaultBranch ?? prefill?.defaultBranch ?? 'main'
  );
  const [executorImage, setExecutorImage] = useState(initial?.executorImage ?? '');
  const [language, setLanguage] = useState(initial?.language ?? prefill?.language ?? '');

  // generic / api_endpoint fields
  const [name, setName] = useState(initial?.name ?? '');
  const [configJson, setConfigJson] = useState(() =>
    initial?.config != null ? JSON.stringify(initial.config, null, 2) : ''
  );

  // shared fields
  const [teamId, setTeamId] = useState(initial?.team?.id ?? '');
  const [description, setDescription] = useState(
    initial?.description ?? prefill?.description ?? ''
  );
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [consolidationEnabled, setConsolidationEnabled] = useState(
    initial?.consolidationEnabled ?? true
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const t = (initial?.type as ConnectionType) ?? 'git_repo';
    setConnType(t);
    setOrganizationName(initial?.organizationName ?? prefill?.organizationName ?? '');
    setRepoName(initial?.repoName ?? prefill?.repoName ?? '');
    setDefaultBranch(initial?.defaultBranch ?? prefill?.defaultBranch ?? 'main');
    setExecutorImage(initial?.executorImage ?? '');
    setLanguage(initial?.language ?? prefill?.language ?? '');
    setName(initial?.name ?? '');
    setConfigJson(initial?.config != null ? JSON.stringify(initial.config, null, 2) : '');
    setDescription(initial?.description ?? prefill?.description ?? '');
    setIsActive(initial?.isActive ?? true);
    setConsolidationEnabled(initial?.consolidationEnabled ?? true);
    setError(null);
  }, [open, initial, prefill]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTeamId((prev) => prev || initial?.team?.id || teams[0]?.id || '');
  }, [open, initial, teams]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    let parsedConfig: Record<string, unknown> | null = null;
    if (connType !== 'git_repo' && configJson.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(configJson);
      } catch {
        setError('Config JSON is invalid');
        return;
      }
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        setError('Config must be a JSON object (e.g. {"key": "value"})');
        return;
      }
      parsedConfig = parsed as Record<string, unknown>;
    }

    try {
      if (mode.kind === 'create') {
        if (connType === 'git_repo') {
          await create.mutateAsync({
            defaultBranch,
            description: description.trim() || undefined,
            executorImage: executorImage.trim() || undefined,
            githubApiUrl: prefill?.githubApiUrl || undefined,
            githubUrl: prefill?.githubUrl || undefined,
            language: language.trim() || undefined,
            organizationName: organizationName.trim(),
            repoName: repoName.trim(),
            teamId,
          });
        } else {
          await create.mutateAsync({
            config: parsedConfig,
            description: description.trim() || undefined,
            name: name.trim() || undefined,
            teamId,
            type: connType,
          });
        }
      } else {
        if (connType === 'git_repo') {
          await update.mutateAsync({
            consolidationEnabled,
            defaultBranch,
            description: description.trim() || null,
            executorImage: executorImage.trim() || null,
            isActive,
            language: language.trim() || null,
            teamId,
          });
        } else {
          await update.mutateAsync({
            config: parsedConfig,
            description: description.trim() || null,
            isActive,
            name: name.trim() || null,
            teamId,
          });
        }
      }
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Failed to save connection'));
    }
  }

  const configJsonError = useMemo(() => {
    if (connType === 'git_repo' || !configJson.trim() || configJson.trim() === '{}') {
      return null;
    }
    try {
      const parsed = JSON.parse(configJson);
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        return 'Must be a JSON object — e.g. {"key": "value"}';
      }
      return null;
    } catch {
      return 'Invalid JSON';
    }
  }, [connType, configJson]);

  const isEdit = mode.kind === 'edit';
  const busy = create.isPending || update.isPending;
  const isGit = connType === 'git_repo';
  // When importing from GitHub the type is always git_repo — hide the type selector.
  const showTypeSelector = !isEdit && !prefill;

  return (
    <Modal
      eyebrow={isEdit ? '§ Edit connection' : '§ Add connection'}
      onClose={onClose}
      open={open}
      subtitle={
        isGit
          ? 'auto-swe clones this repo into an ephemeral Docker container per work request and opens pull requests back here.'
          : 'A named external system your workflows can target or reference.'
      }
      title={mode.kind === 'edit' ? connectionLabel(mode.repo) : 'Add a connection'}
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        {showTypeSelector && (
          <Select
            id="conn-type"
            label="Connection type"
            onChange={(e) => setConnType(e.target.value as ConnectionType)}
            value={connType}
          >
            {CONNECTION_TYPES.map(({ label, value }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        )}

        {isGit ? (
          <>
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
          </>
        ) : (
          <>
            <Input
              label="Name"
              onChange={(e) => setName(e.target.value)}
              placeholder={connType === 'api_endpoint' ? 'Payments API (prod)' : 'My integration'}
              required
              value={name}
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
            <div className="space-y-1">
              <label
                className="block text-xs font-medium uppercase tracking-wider text-paper-400"
                htmlFor="conn-config-json"
              >
                Config (JSON)
                <span className="ml-1 font-normal normal-case text-paper-500">
                  {connType === 'api_endpoint'
                    ? '— e.g. {"baseUrl":"https://api.example.com","authType":"bearer"}'
                    : '— arbitrary key/value pairs for workflow use'}
                </span>
              </label>
              <textarea
                className={`w-full rounded border bg-ink-800 p-2 font-mono text-xs text-paper-200 focus:outline-none ${configJsonError ? 'border-brick-400 focus:border-brick-400' : 'border-ink-600 focus:border-ember-400'}`}
                id="conn-config-json"
                onChange={(e) => setConfigJson(e.target.value)}
                placeholder="{}"
                rows={5}
                value={configJson}
              />
              {configJsonError && (
                <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">
                  {configJsonError}
                </p>
              )}
            </div>
          </>
        )}

        <Input
          label="Description (optional)"
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this connection is used for"
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
              <span>Active — accept new work requests</span>
            </label>
            {isGit && (
              <label className="flex items-center gap-2 text-xs text-paper-300">
                <input
                  checked={consolidationEnabled}
                  onChange={(e) => setConsolidationEnabled(e.target.checked)}
                  type="checkbox"
                />
                <span>Include in scheduled lesson consolidation</span>
              </label>
            )}
          </div>
        )}

        {error && (
          <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">{error}</p>
        )}
        <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy || !teamId || !!configJsonError} type="submit" variant="primary">
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add connection'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
