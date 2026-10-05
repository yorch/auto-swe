'use client';

import type { ConnectionType } from '@auto-swe/shared/lib/connectionTypes';
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Combobox } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useCreateRepository, useUpdateRepository } from '@/hooks/useRepositories';
import { useLedTeamIds, useTeams } from '@/hooks/useTeams';
import { connectionLabel } from '@/lib/connectionDisplay';
import {
  initialConnectionType,
  parseConnectionConfig,
  secretLikeConfigKeys,
  selectableConnectionTypes,
} from '@/lib/connectionForm';
import { errMsg } from '@/lib/errors';
import { canWriteTeamResource } from '@/lib/teamPermissions';
import { useAuthStore } from '@/stores/authStore';

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

const CONNECTION_TYPE_OPTIONS = selectableConnectionTypes();

export function ConnectionFormModal({
  open,
  onClose,
  mode,
}: {
  open: boolean;
  onClose: () => void;
  mode: Mode;
}) {
  const { data: allTeams } = useTeams();
  // Only teams the caller may write connections for (canManageTeamRepos): a
  // platform LEAD sees every team they belong to in the list, but can only
  // onboard into or reassign to one they lead.
  const platformRole = useAuthStore((s) => s.user?.role);
  const ledTeamIds = useLedTeamIds();
  const teams = useMemo(
    () => (allTeams ?? []).filter((t) => canWriteTeamResource(platformRole, t.id, ledTeamIds)),
    [allTeams, platformRole, ledTeamIds]
  );
  const create = useCreateRepository();
  const update = useUpdateRepository(mode.kind === 'edit' ? mode.repo.id : '');

  const initial = mode.kind === 'edit' ? mode.repo : null;
  const prefill = mode.kind === 'create' ? mode.prefill : undefined;

  const [connType, setConnType] = useState<ConnectionType>(initialConnectionType(initial?.type));

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

  // non-git fields (name + type-specific config)
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
    setConnType(initialConnectionType(initial?.type));
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
    if (connType !== 'git_repo') {
      const parsed = parseConnectionConfig(configJson);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      parsedConfig = parsed.config;
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
            // The create schema is optional, not nullable: omit a blank config.
            config: parsedConfig ?? undefined,
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

  const secretKeys = useMemo(() => {
    if (connType === 'git_repo') {
      return [];
    }
    const parsed = parseConnectionConfig(configJson);
    return parsed.ok ? secretLikeConfigKeys(parsed.config) : [];
  }, [connType, configJson]);

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
          ? 'The platform clones this repo into an ephemeral container per run and opens pull requests back here.'
          : 'A named external system your workflows can target or reference.'
      }
      title={mode.kind === 'edit' ? connectionLabel(mode.repo) : 'Add a connection'}
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        {showTypeSelector && (
          <Select
            id="conn-type"
            label="Connection type"
            onChange={(v) => {
              const match = CONNECTION_TYPE_OPTIONS.find((t) => t.value === v);
              if (match) {
                setConnType(match.value);
              }
            }}
            options={CONNECTION_TYPE_OPTIONS.map(({ label, value }) => ({ label, value }))}
            value={connType}
          />
        )}

        {isGit ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label="Default branch"
                onChange={(e) => setDefaultBranch(e.target.value)}
                required
                value={defaultBranch}
              />
              <Combobox
                id="team"
                label="Team"
                onChange={setTeamId}
                options={teams.map((t) => ({ label: t.name, value: t.id }))}
                placeholder="Select a team"
                required
                value={teamId}
              />
            </div>
            <Input
              hint="The image each run starts from. Blank uses the deployment's default workspace image."
              label="Executor image"
              onChange={(e) => setExecutorImage(e.target.value)}
              placeholder="Deployment default"
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
              placeholder={connType === 'http_api' ? 'Payments API (prod)' : 'My integration'}
              required
              value={name}
            />
            <Combobox
              id="team"
              label="Team"
              onChange={setTeamId}
              options={teams.map((t) => ({ label: t.name, value: t.id }))}
              placeholder="Select a team"
              required
              value={teamId}
            />
            <Textarea
              compact
              error={configJsonError ?? undefined}
              hint={
                connType === 'http_api'
                  ? 'e.g. {"baseUrl":"https://api.example.com","authType":"bearer"}'
                  : 'Arbitrary key/value pairs for workflow use'
              }
              id="conn-config-json"
              label="Config (JSON)"
              onChange={(e) => setConfigJson(e.target.value)}
              placeholder="{}"
              rows={5}
              value={configJson}
            />
            <Alert variant={secretKeys.length > 0 ? 'warning' : 'info'}>
              {secretKeys.length > 0 ? `${secretKeys.join(', ')} looks like a credential. ` : ''}
              Config is stored as plain text and visible to this connection's team. Don't put
              tokens, passwords or API keys here.
            </Alert>
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
            <ToggleSwitch
              checked={isActive}
              label="Active — accept new work requests"
              onChange={() => setIsActive((v) => !v)}
            />
            {isGit && (
              <ToggleSwitch
                checked={consolidationEnabled}
                label="Include in scheduled lesson consolidation"
                onChange={() => setConsolidationEnabled((v) => !v)}
              />
            )}
          </div>
        )}

        {error && <Alert>{error}</Alert>}
        <ModalFooter
          disabled={!teamId || !!configJsonError}
          isPending={busy}
          onCancel={onClose}
          pendingLabel="Saving…"
          submitLabel={isEdit ? 'Save changes' : 'Create connection'}
        />
      </form>
    </Modal>
  );
}
