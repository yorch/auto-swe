'use client';

import type { ConnectionType } from '@auto-swe/shared/lib/connectionTypes';
import type { PreviewConfig } from '@auto-swe/shared/lib/previewConfig';
import { isPrTitleFormat } from '@auto-swe/shared/lib/prTitle';
import type { RepoSetup } from '@auto-swe/shared/lib/repoSetup';
import { MAX_UNCOVERED_COMPONENTS, uncoveredComponents } from '@auto-swe/shared/lib/stackDetection';
import {
  type ExecutorImageProbeResult,
  REPO_GATE_COMMAND_KEYS,
  type RepositorySummary,
} from '@auto-swe/shared/types/api';
import { useEffect, useMemo, useState } from 'react';
import { PreviewEnvToSecrets } from '@/components/repositories/PreviewEnvToSecrets';
import { RepoSetupEditor } from '@/components/repositories/RepoSetupEditor';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useCreateRepository, useUpdateRepository } from '@/hooks/useRepositories';
import { useAdminTeamIds, useLedTeamIds, useTeams } from '@/hooks/useTeams';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
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
import { draftToSetup, type RepoSetupDraft, setupDraft } from '@/lib/repoSetupDraft';
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

const ADMIN_ONLY_HINT = 'Only a platform admin or an admin of the repository’s team can edit this.';

/** `inherit` stores null: the repository follows the team, organization and global setting. */
type PrTitleFormChoice = 'inherit' | 'template' | 'conventional';

const PR_TITLE_FORMAT_OPTIONS: Array<{ label: string; value: PrTitleFormChoice }> = [
  { label: 'Inherit from team, organization or global', value: 'inherit' },
  { label: 'Template', value: 'template' },
  { label: 'Conventional Commits', value: 'conventional' },
];

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
  const uncovered = uncoveredComponents(initial?.detectedStack);
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
  const [previewConfigJson, setPreviewConfigJson] = useState(() =>
    initial?.previewConfig != null ? JSON.stringify(initial.previewConfig, null, 2) : ''
  );
  const [setup, setSetup] = useState<RepoSetupDraft>(() =>
    setupDraft(initial?.setup as RepoSetup | null | undefined)
  );
  const [language, setLanguage] = useState(initial?.language ?? prefill?.language ?? '');
  const [prTitleFormat, setPrTitleFormat] = useState<PrTitleFormChoice>(
    initial?.prTitleFormat ?? 'inherit'
  );
  const [prTitleTemplate, setPrTitleTemplate] = useState(initial?.prTitleTemplate ?? '');

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
  // Closed when onboarding; open when editing a repository that already sets one of them.
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      !!initial &&
      (initial.gateCommands != null ||
        initial.previewConfig != null ||
        initial.setup != null ||
        !!initial.detectedStack)
  );

  const [touched, setTouched] = useState(false);
  const [acknowledgedSecrets, setAcknowledgedSecrets] = useState(false);
  useUnsavedChangesGuard(open && touched);

  // Fields reset when the dialog opens or a different connection is shown, never because a
  // refetch handed back a new object for the same one: that would wipe what the person is
  // typing. Adjusting state while rendering, keyed on identity rather than on the object, is
  // the supported way to do that without an effect.
  const resetKey = open ? (initial?.id ?? 'new') : null;
  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  if (seenResetKey !== resetKey) {
    setSeenResetKey(resetKey);
    if (resetKey !== null) {
      setTouched(false);
      setAcknowledgedSecrets(false);
      setConnType(initialConnectionType(initial?.type));
      setOrganizationName(initial?.organizationName ?? prefill?.organizationName ?? '');
      setRepoName(initial?.repoName ?? prefill?.repoName ?? '');
      setDefaultBranch(initial?.defaultBranch ?? prefill?.defaultBranch ?? 'main');
      setExecutorImage(initial?.executorImage ?? '');
      setGateCommands(gateCommandsForm(initial?.gateCommands));
      setPreviewConfigJson(
        initial?.previewConfig != null ? JSON.stringify(initial.previewConfig, null, 2) : ''
      );
      setSetup(setupDraft(initial?.setup as RepoSetup | null | undefined));
      setLanguage(initial?.language ?? prefill?.language ?? '');
      setPrTitleFormat(initial?.prTitleFormat ?? 'inherit');
      setPrTitleTemplate(initial?.prTitleTemplate ?? '');
      setName(initial?.name ?? '');
      setConfigJson(initial?.config != null ? JSON.stringify(initial.config, null, 2) : '');
      setDescription(initial?.description ?? prefill?.description ?? '');
      setIsActive(initial?.isActive ?? true);
      setConsolidationEnabled(initial?.consolidationEnabled ?? true);
      setError(null);
    }
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    setTeamId(
      (prev) => prev || initial?.team?.id || (teams.length === 1 ? teams[0]?.id : '') || ''
    );
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
    let parsedPreviewConfig: PreviewConfig | null | undefined;
    if (connType === 'git_repo' && previewConfigJson.trim()) {
      try {
        const value: unknown = JSON.parse(previewConfigJson);
        if (value === null || Array.isArray(value) || typeof value !== 'object') {
          setError('App preview must be a JSON object');
          return;
        }
        parsedPreviewConfig = value as PreviewConfig;
      } catch (err) {
        setError(
          `App preview JSON is invalid: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
    } else if (mode.kind === 'edit' && initial?.previewConfig != null) {
      parsedPreviewConfig = null;
    }
    let parsedSetup: RepoSetup | null | undefined;
    if (connType === 'git_repo' && setup.enabled) {
      const checked = draftToSetup(setup);
      if (!checked.ok) {
        setError(`Workspace setup is invalid: ${checked.error}`);
        return;
      }
      parsedSetup = checked.setup;
    } else if (mode.kind === 'edit' && initial?.setup != null) {
      parsedSetup = null;
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
            ...(parsedPreviewConfig !== undefined
              ? { previewConfig: parsedPreviewConfig as PreviewConfig }
              : {}),
            ...(parsedSetup ? { setup: parsedSetup } : {}),
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
            ...(parsedPreviewConfig !== undefined ? { previewConfig: parsedPreviewConfig } : {}),
            ...(parsedSetup !== undefined ? { setup: parsedSetup } : {}),
            isActive,
            language: language.trim() || null,
            prTitleFormat: prTitleFormat === 'inherit' ? null : prTitleFormat,
            prTitleTemplate: prTitleTemplate.trim() || null,
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
      <form className="space-y-5" onChange={() => setTouched(true)} onSubmit={handleSubmit}>
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
                hint={
                  teams.length > 1 && !teamId ? 'The team that owns this connection.' : undefined
                }
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
                  <Button
                    disabled={probing}
                    onClick={handleProbe}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {probing ? 'Checking image…' : 'Check image'}
                  </Button>
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
            {!isEdit && (
              <p className="text-xs text-paper-500">
                The pull request title format can be set after the connection is created.
              </p>
            )}
            {isEdit && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Select
                  hint="How the pull requests opened for this repository are titled. Conventional Commits writes `type: summary`."
                  id="pr-title-format"
                  label="PR title format"
                  onChange={(v) => {
                    if (v === 'inherit' || isPrTitleFormat(v)) {
                      setPrTitleFormat(v);
                    }
                  }}
                  options={PR_TITLE_FORMAT_OPTIONS}
                  value={prTitleFormat}
                />
                <Input
                  disabled={prTitleFormat === 'conventional'}
                  hint="Placeholders: {{ticketId}}, {{description}}. Blank inherits."
                  id="pr-title-template"
                  label="PR title template"
                  onChange={(e) => setPrTitleTemplate(e.target.value)}
                  placeholder="[auto-swe] {{ticketId}}"
                  value={prTitleTemplate}
                />
              </div>
            )}
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
                {uncovered.length > 0 && (
                  <p className="mt-1 text-warning-400">
                    Default gates cover the repository root only. Not covered:{' '}
                    {uncovered
                      .slice(0, 5)
                      .map((c) => `${c.path} (${c.stacks.join(', ')})`)
                      .join(', ')}
                    {uncovered.length > 5 &&
                      (uncovered.length >= MAX_UNCOVERED_COMPONENTS
                        ? ', and more'
                        : `, and ${uncovered.length - 5} more`)}
                    . Set gate commands that <code>cd</code> into them.
                  </p>
                )}
                {(initial.detectedStack.componentsTruncated ||
                  initial.detectedStack.treeTruncated) && (
                  <p className="mt-1 text-xs">
                    Detection is partial: the repository tree or component list was truncated.
                  </p>
                )}
                {Object.keys(initial.detectedStack.suggestedGateCommands).length > 0 && (
                  <Button
                    className="mt-1"
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
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Use suggested gate commands
                  </Button>
                )}
              </Alert>
            )}
            <details
              className="rounded-lg border border-ink-500/60 bg-ink-800/40 p-4"
              onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
              open={advancedOpen}
            >
              <summary className="cursor-pointer text-sm font-medium text-paper-200">
                Advanced: gate commands and app preview
              </summary>
              <div className="mt-4 space-y-5">
                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium text-paper-200">Gate commands</legend>
                  <p className="text-xs leading-relaxed text-paper-400">
                    Run by a gate step that sets no command of its own. Blank uses the built-in
                    default. {GATE_COMMANDS_RULE}
                  </p>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {REPO_GATE_COMMAND_KEYS.map((key) => (
                      <Input
                        className="font-mono text-xs"
                        disabled={!canEditGateCommands}
                        hint={canEditGateCommands ? undefined : ADMIN_ONLY_HINT}
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
                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium text-paper-200">App preview</legend>
                  <p className="text-xs leading-relaxed text-paper-400">
                    Optional JSON recipe for starting this repository in a workspace. Its setup
                    command runs after Workspace setup, in preview sessions only, with the recipe's
                    env and the setup secrets it names under "secrets" (env is stored as plain
                    text): keep dependency installs in Workspace setup. Clearing this field removes
                    the saved recipe.
                  </p>
                  <Textarea
                    disabled={!canEditGateCommands}
                    hint={canEditGateCommands ? undefined : ADMIN_ONLY_HINT}
                    id="app-preview-config"
                    label="App preview (UI validation)"
                    onChange={(e) => setPreviewConfigJson(e.target.value)}
                    placeholder={
                      '{\n  "start": "npm run dev",\n  "readyUrl": "http://localhost:3000"\n}'
                    }
                    rows={10}
                    spellCheck={false}
                    value={previewConfigJson}
                  />
                  {isEdit && initial?.id && (
                    <PreviewEnvToSecrets
                      disabled={!canEditGateCommands}
                      env={(initial.previewConfig as { env?: Record<string, string> } | null)?.env}
                      publicEnv={(initial.previewConfig as { publicEnv?: string[] } | null)?.publicEnv}
                      onMoved={(next) => setPreviewConfigJson(JSON.stringify(next, null, 2))}
                      repositoryId={initial.id}
                    />
                  )}
                </fieldset>
                <fieldset className="min-w-0 space-y-3">
                  <legend className="text-sm font-medium text-paper-200">Workspace setup</legend>
                  <p className="text-xs leading-relaxed text-paper-400">
                    Run in every workspace after the checkout, evals included: submodules, LFS,
                    install steps and a dependency cache.
                  </p>
                  <RepoSetupEditor
                    detectedStack={initial?.detectedStack}
                    disabled={!canEditGateCommands}
                    disabledHint={ADMIN_ONLY_HINT}
                    draft={setup}
                    onChange={(next) => {
                      setTouched(true);
                      setSetup(next);
                    }}
                    repositoryId={isEdit ? initial?.id : undefined}
                  />
                </fieldset>
              </div>
            </details>
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
            {secretKeys.length > 0 ? (
              <Alert title="This looks like a credential" variant="warning">
                <p>
                  {secretKeys.join(', ')} in the config. Config is stored as plain text and visible
                  to this connection's team, so don't put tokens, passwords or API keys here.
                </p>
                <div className="mt-2">
                  <Checkbox
                    checked={acknowledgedSecrets}
                    label="I understand, and these values are not secrets"
                    onChange={(e) => setAcknowledgedSecrets(e.target.checked)}
                  />
                </div>
              </Alert>
            ) : (
              <p className="text-xs leading-relaxed text-paper-400">
                Config is stored as plain text and visible to this connection's team. Don't put
                tokens, passwords or API keys here.
              </p>
            )}
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
            {!isActive && (
              <p className="text-xs leading-relaxed text-warning-400">
                Saving this deactivates the connection: it refuses new work requests
                {mode.kind === 'edit' && (mode.repo._count?.activeWorkflows ?? 0) > 0
                  ? ` and ${mode.repo._count.activeWorkflows} workflow${mode.repo._count.activeWorkflows === 1 ? ' is' : 's are'} still running on it`
                  : ''}
                . Reactivate it here at any time.
              </p>
            )}
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
          disabled={!teamId || !!configJsonError || (secretKeys.length > 0 && !acknowledgedSecrets)}
          isPending={busy}
          onCancel={onClose}
          pendingLabel="Saving…"
          submitLabel={isEdit ? 'Save changes' : 'Create connection'}
        />
      </form>
    </Modal>
  );
}
