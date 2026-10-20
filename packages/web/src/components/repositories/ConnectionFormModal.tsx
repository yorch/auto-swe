'use client';

import type { ConnectionType } from '@auto-swe/shared/lib/connectionTypes';
import {
  type ExecutorImageProbeResult,
  REPO_GATE_COMMAND_KEYS,
  type RepositorySummary,
} from '@auto-swe/shared/types/api';
import { useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Combobox } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useCreateRepository, useUpdateRepository } from '@/hooks/useRepositories';
import { useAdminTeamIds, useLedTeamIds, useTeams } from '@/hooks/useTeams';
import { api } from '@/lib/api';
import { connectionLabel } from '@/lib/connectionDisplay';
import {
  initialConnectionType,
  parseConnectionConfig,
  secretLikeConfigKeys,
  selectableConnectionTypes,
} from '@/lib/connectionForm';
import { errMsg } from '@/lib/errors';
import {
  GATE_COMMAND_LABELS,
  GATE_COMMANDS_RULE,
  type GateCommandsForm,
  gateCommandsForm,
  gateCommandsPatch,
} from '@/lib/gateCommandsForm';
import { canAuthorTeamCode, canWriteTeamResource } from '@/lib/teamPermissions';
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
  const adminTeamIds = useAdminTeamIds();
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
  const [gateCommands, setGateCommands] = useState<GateCommandsForm>(() =>
    gateCommandsForm(initial?.gateCommands)
  );
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
  const [probe, setProbe] = useState<ExecutorImageProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setConnType(initialConnectionType(initial?.type));
    setOrganizationName(initial?.organizationName ?? prefill?.organizationName ?? '');
    setRepoName(initial?.repoName ?? prefill?.repoName ?? '');
    setDefaultBranch(initial?.defaultBranch ?? prefill?.defaultBranch ?? 'main');
    setExecutorImage(initial?.executorImage ?? '');
    setGateCommands(gateCommandsForm(initial?.gateCommands));
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
          // Only a set that runs something is sent, so onboarding without one needs no role.
          const gateCreate = gateCommandsPatch(null, gateCommands);
          await create.mutateAsync({
            defaultBranch,
            description: description.trim() || undefined,
            executorImage: executorImage.trim() || undefined,
            ...(gateCreate ? { gateCommands: gateCreate } : {}),
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
          const gatePatch = gateCommandsPatch(initial?.gateCommands, gateCommands);
          await update.mutateAsync({
            consolidationEnabled,
            defaultBranch,
            description: description.trim() || null,
            executorImage: executorImage.trim() || null,
            ...(gatePatch !== undefined ? { gateCommands: gatePatch } : {}),
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
  const isPlatformAdmin = platformRole === 'ADMIN';
  const busy = create.isPending || update.isPending;

  async function handleProbe() {
    if (mode.kind !== 'edit') {
      return;
    }
    setProbing(true);
    setProbe(null);
    try {
      const res = await api.post<{ data: ExecutorImageProbeResult }>(
        `/api/v1/repositories/${mode.repo.id}/executor-image/probe`,
        { image: executorImage.trim() || undefined }
      );
      setProbe(res.data);
    } catch (err) {
      setError(errMsg(err, 'The image probe could not run'));
    } finally {
      setProbing(false);
    }
  }
  const isGit = connType === 'git_repo';
  // Judged on the team the repository will be saved to, as the gateway does.
  const canEditGateCommands = canAuthorTeamCode(platformRole, teamId, adminTeamIds);
  // When importing from GitHub the type is always git_repo — hide the type selector.
  const showTypeSelector = !isEdit && !prefill;

  return (
    <Modal
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
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Input
                  hint="Blank uses the deployment's default workspace image."
                  label="Executor image"
                  onChange={(e) => setExecutorImage(e.target.value)}
                  placeholder="Deployment default"
                  value={executorImage}
                />
                {isEdit && isPlatformAdmin && (
                  <button
                    className="text-xs text-accent-400 disabled:opacity-50"
                    disabled={probing}
                    onClick={handleProbe}
                    type="button"
                  >
                    {probing ? 'Checking image…' : 'Check image'}
                  </button>
                )}
              </div>
              <Input
                hint="Optional. Helps agents pick the right tooling."
                label="Language"
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="typescript, python, ruby…"
                value={language}
              />
            </div>
            {probe && (
              <Alert variant={probe.ok ? 'info' : 'warning'}>
                <p className="font-medium">
                  {probe.ok
                    ? `${probe.image} meets the executor image contract`
                    : `${probe.image} fails the executor image contract`}
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {probe.checks.map((c) => (
                    <li key={c.name}>
                      {c.ok ? '✓' : '✗'} {c.name}
                      {c.required ? '' : ' (optional)'} — {c.detail}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {initial?.detectedStack && initial.detectedStack.stacks.length > 0 && (
              <Alert variant="info">
                <p>
                  Detected: {initial.detectedStack.stacks.join(', ')}
                  {initial.detectedStack.suggestedDockerfile &&
                    ` — suggested executor build: defaults/Dockerfile.${initial.detectedStack.suggestedDockerfile}`}
                </p>
                {initial.detectedStack.components &&
                  initial.detectedStack.components.length > 1 && (
                    <p className="mt-1">
                      {initial.detectedStack.components
                        .map((c) => `${c.path || '(root)'}: ${c.stacks.join(', ')}`)
                        .join('; ')}
                    </p>
                  )}
                {(initial.detectedStack.componentsTruncated ||
                  initial.detectedStack.treeTruncated) && (
                  <p className="mt-1 text-xs">
                    Detection is partial: the repository tree or component list was truncated.
                  </p>
                )}
                {Object.keys(initial.detectedStack.suggestedGateCommands).length > 0 && (
                  <button
                    className="mt-1 text-xs text-accent-400"
                    onClick={() =>
                      setGateCommands((prev) => ({
                        ...prev,
                        ...Object.fromEntries(
                          Object.entries(initial.detectedStack?.suggestedGateCommands ?? {}).map(
                            ([k, v]) => [k, v ?? '']
                          )
                        ),
                      }))
                    }
                    type="button"
                  >
                    Use suggested gate commands
                  </button>
                )}
              </Alert>
            )}
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-paper-200">Gate commands</legend>
              <p className="text-xs leading-relaxed text-paper-400">
                Run by a gate step that sets no command of its own. Blank uses the built-in default.{' '}
                {GATE_COMMANDS_RULE}
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {REPO_GATE_COMMAND_KEYS.map((key) => (
                  <Input
                    className="font-mono text-xs"
                    disabled={!canEditGateCommands}
                    id={`gate-command-${key}`}
                    key={key}
                    label={GATE_COMMAND_LABELS[key]}
                    onChange={(e) =>
                      setGateCommands((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    placeholder="Built-in default"
                    spellCheck={false}
                    value={gateCommands[key]}
                  />
                ))}
              </div>
            </fieldset>
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
          hint="Optional. Helps people pick the right connection."
          label="Description"
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this connection is used for"
          value={description}
        />

        {isEdit && (
          <div className="space-y-3 rounded-lg border border-ink-500/60 bg-ink-800/40 p-4">
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
