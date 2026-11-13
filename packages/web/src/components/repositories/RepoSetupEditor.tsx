'use client';

import { REPO_SETUP_FILE, repoSetupToYaml, starterRepoSetup } from '@auto-swe/shared/lib/repoSetup';
import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { CopyButton } from '@/components/ui/CopyButton';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useProposeSetupFile, useSetupFileProposalStatus } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';
import {
  draftToSetup,
  EMPTY_STEP,
  type RepoSetupDraft,
  type SetupStepDraft,
  type SubmodulesChoice,
  setupDraft,
} from '@/lib/repoSetupDraft';
import { RepoEvalDatasets } from './RepoEvalDatasets';
import { RepoSetupHealth } from './RepoSetupHealth';
import { RepoSetupSecrets } from './RepoSetupSecrets';
import { RunOnboardingButton } from './RunOnboardingButton';

const SUBMODULE_OPTIONS: Array<{ label: string; value: SubmodulesChoice }> = [
  { label: 'Not fetched', value: 'off' },
  { label: 'Top level only', value: 'on' },
  { label: 'Recursive', value: 'recursive' },
];

interface RepoSetupEditorProps {
  draft: RepoSetupDraft;
  onChange: (draft: RepoSetupDraft) => void;
  disabled: boolean;
  disabledHint?: string;
  /** The stored stack detection, for the starter definition. */
  detectedStack: unknown;
  /** Set when editing a saved repository: enables opening a pull request with the file. */
  repositoryId?: string;
}

/**
 * The repository form's Workspace setup section: the definition as fields, plus the same
 * definition as `.auto-swe/setup.yml` to copy, download or open as a pull request.
 */
export function RepoSetupEditor({
  detectedStack,
  disabled,
  disabledHint,
  draft,
  onChange,
  repositoryId,
}: RepoSetupEditorProps) {
  const set = (patch: Partial<RepoSetupDraft>) => onChange({ ...draft, ...patch });
  const setStep = (i: number, patch: Partial<SetupStepDraft>) =>
    set({ steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const checked = useMemo(() => draftToSetup(draft), [draft]);
  // The file shown is what the fields describe; with the section off, a starter from the stack.
  const fileSetup = checked.ok && checked.setup ? checked.setup : starterRepoSetup(detectedStack);
  const fileText = useMemo(() => repoSetupToYaml(fileSetup), [fileSetup]);
  const fileValid = !draft.enabled || checked.ok;

  return (
    <div className="space-y-3">
      <Checkbox
        checked={draft.enabled}
        disabled={disabled}
        hint={
          draft.enabled
            ? `Replaces the repository's ${REPO_SETUP_FILE}.`
            : `Off: the repository's ${REPO_SETUP_FILE} on the default branch is used; without one, the stack default when that setting is on.`
        }
        label="Define workspace setup here"
        onChange={(e) =>
          onChange(
            e.target.checked && draft.steps.length === 0 && !draft.cachePaths
              ? { ...setupDraft(starterRepoSetup(detectedStack)), enabled: true }
              : { ...draft, enabled: e.target.checked }
          )
        }
      />
      {disabled && disabledHint && <p className="text-xs text-paper-500">{disabledHint}</p>}

      {draft.enabled && (
        <div className="space-y-4 rounded-lg border border-ink-600 p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              disabled={disabled}
              hint="Same-host submodules only, each with its own credential."
              label="Submodules"
              onChange={(v) => set({ submodules: v as SubmodulesChoice })}
              options={SUBMODULE_OPTIONS}
              value={draft.submodules}
            />
            <div className="pt-6">
              <Checkbox
                checked={draft.lfs}
                disabled={disabled}
                label="Fetch Git LFS objects"
                onChange={(e) => set({ lfs: e.target.checked })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm text-paper-200">Steps</h4>
              <Button
                disabled={disabled || draft.steps.length >= 20}
                onClick={() => set({ steps: [...draft.steps, EMPTY_STEP] })}
                size="sm"
              >
                <Icon name="plus" size={13} />
                Add step
              </Button>
            </div>
            <p className="text-xs text-paper-500">
              Run in order as the workspace user after the network lock; package installs go through
              the registry proxy.
            </p>
            {draft.steps.map((step, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
              <div className="space-y-2 rounded-md border border-ink-600 p-2" key={i}>
                <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_7rem_auto]">
                  <Input
                    compact
                    disabled={disabled}
                    label={`Step ${i + 1} name`}
                    onChange={(e) => setStep(i, { name: e.target.value })}
                    placeholder="install"
                    value={step.name}
                  />
                  <Input
                    compact
                    disabled={disabled}
                    label="Directory"
                    onChange={(e) => setStep(i, { workdir: e.target.value })}
                    placeholder="repository root"
                    value={step.workdir}
                  />
                  <Input
                    compact
                    disabled={disabled}
                    inputMode="numeric"
                    label="Timeout (s)"
                    onChange={(e) => setStep(i, { timeout: e.target.value })}
                    placeholder="600"
                    value={step.timeout}
                  />
                  <Button
                    aria-label={`Remove step ${i + 1}`}
                    className="px-2 hover:text-danger-400"
                    disabled={disabled}
                    onClick={() => set({ steps: draft.steps.filter((_, j) => j !== i) })}
                    size="sm"
                    title="Remove step"
                    variant="ghost"
                  >
                    <Icon name="trash" size={14} />
                  </Button>
                </div>
                <Textarea
                  compact
                  disabled={disabled}
                  label={`Step ${i + 1} command`}
                  onChange={(e) => setStep(i, { run: e.target.value })}
                  placeholder="yarn install --immutable"
                  rows={2}
                  spellCheck={false}
                  value={step.run}
                />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Textarea
              compact
              disabled={disabled}
              hint="One per line, relative to the repository or under ~/."
              label="Cache paths"
              onChange={(e) => set({ cachePaths: e.target.value })}
              placeholder="node_modules"
              rows={3}
              spellCheck={false}
              value={draft.cachePaths}
            />
            <Textarea
              compact
              disabled={disabled}
              hint="One per line; globs such as **/build.gradle match tracked files. A change to any of them starts a fresh cache."
              label="Cache key files"
              onChange={(e) => set({ cacheKeyFiles: e.target.value })}
              placeholder="yarn.lock"
              rows={3}
              spellCheck={false}
              value={draft.cacheKeyFiles}
            />
          </div>
          <Textarea
            compact
            disabled={disabled}
            hint="Deleted after the steps, before the agent starts or the cache is saved: files a step wrote a secret into. Setup fails if a secret value is left anywhere in the checkout or the home directory."
            label="Cleanup"
            onChange={(e) => set({ cleanup: e.target.value })}
            placeholder="~/.npmrc"
            rows={2}
            spellCheck={false}
            value={draft.cleanup}
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm text-paper-200">Environment</h4>
              <Button
                disabled={disabled}
                onClick={() => set({ env: [...draft.env, { key: '', value: '' }] })}
                size="sm"
              >
                <Icon name="plus" size={13} />
                Add variable
              </Button>
            </div>
            <p className="text-xs text-paper-500">
              Upper-case names. Not for secrets: values are stored and shown as plain text.
            </p>
            {draft.env.map((pair, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
              <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2" key={i}>
                <Input
                  compact
                  disabled={disabled}
                  label={`Variable ${i + 1} name`}
                  onChange={(e) =>
                    set({
                      env: draft.env.map((p, j) => (j === i ? { ...p, key: e.target.value } : p)),
                    })
                  }
                  placeholder="CI"
                  value={pair.key}
                />
                <Input
                  compact
                  disabled={disabled}
                  label="Value"
                  onChange={(e) =>
                    set({
                      env: draft.env.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)),
                    })
                  }
                  placeholder="1"
                  value={pair.value}
                />
                <Button
                  aria-label={`Remove variable ${i + 1}`}
                  className="px-2 hover:text-danger-400"
                  disabled={disabled}
                  onClick={() => set({ env: draft.env.filter((_, j) => j !== i) })}
                  size="sm"
                  title="Remove variable"
                  variant="ghost"
                >
                  <Icon name="trash" size={14} />
                </Button>
              </div>
            ))}
          </div>

          <Textarea
            compact
            disabled={disabled}
            hint="One per line. Each must be saved under Setup secrets; steps get it as an environment variable."
            label="Secret names"
            onChange={(e) => set({ secrets: e.target.value })}
            placeholder="NPM_TOKEN"
            rows={2}
            spellCheck={false}
            value={draft.secrets}
          />

          {!checked.ok && (
            <Alert variant="error">Workspace setup is invalid: {checked.error}</Alert>
          )}
        </div>
      )}

      {repositoryId && <RepoSetupSecrets disabled={disabled} repositoryId={repositoryId} />}
      {repositoryId && <RepoSetupHealth disabled={disabled} repositoryId={repositoryId} />}
      {repositoryId && <RunOnboardingButton canRun={!disabled} repositoryId={repositoryId} />}
      {repositoryId && <RepoEvalDatasets repositoryId={repositoryId} />}

      <SetupFilePanel
        canPropose={!disabled && fileValid}
        repositoryId={repositoryId}
        setupForPr={fileSetup}
        text={fileText}
        title={
          draft.enabled
            ? `These fields as ${REPO_SETUP_FILE}`
            : `Starter ${REPO_SETUP_FILE} from the detected stack`
        }
      />
    </div>
  );
}

function SetupFilePanel({
  canPropose,
  repositoryId,
  setupForPr,
  text,
  title,
}: {
  canPropose: boolean;
  repositoryId?: string;
  setupForPr: Parameters<typeof repoSetupToYaml>[0];
  text: string;
  title: string;
}) {
  const propose = useProposeSetupFile(repositoryId ?? '');
  const proposal = useSetupFileProposalStatus(repositoryId ?? '', propose.data?.requestId ?? null);
  const [error, setError] = useState<string | null>(null);
  const state = proposal.data?.status;
  const busy = propose.isPending || state === 'queued' || (propose.isSuccess && !proposal.data);

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'setup.yml';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <details className="min-w-0 max-w-full rounded-lg border border-ink-600 p-3">
      <summary className="cursor-pointer text-sm text-paper-200">
        Keep it in the repository: {title}
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs text-paper-500">
          Commit this file to version the setup with the code. A definition saved on the repository
          here takes precedence over it.
        </p>
        <pre className="max-h-64 max-w-full overflow-auto whitespace-pre rounded-md bg-ink-800 p-2 font-mono text-xs text-paper-300">
          {text}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton value={text} />
          <Button onClick={download} size="sm">
            Download
          </Button>
          {repositoryId && (
            <Button
              disabled={!canPropose || busy}
              onClick={() => {
                setError(null);
                propose.mutate(setupForPr, {
                  onError: (err) => setError(errMsg(err, 'The pull request could not be opened')),
                });
              }}
              size="sm"
            >
              {busy ? 'Queued…' : `Open a PR adding ${REPO_SETUP_FILE}`}
            </Button>
          )}
        </div>
        {state === 'queued' && (
          <Alert variant="info">
            Queued: a worker opens the pull request. This page updates when it has.
          </Alert>
        )}
        {proposal.data?.status === 'opened' && (
          <Alert variant="success">
            Pull request opened:{' '}
            <a className="underline" href={proposal.data.prUrl} rel="noreferrer" target="_blank">
              {proposal.data.prUrl}
            </a>
          </Alert>
        )}
        {proposal.data?.status === 'failed' && (
          <Alert variant="error">The pull request was not opened: {proposal.data.detail}</Alert>
        )}
        {proposal.isError && (
          <Alert variant="error">
            {errMsg(proposal.error, 'The pull request status could not be read')}
          </Alert>
        )}
        {error && <Alert variant="error">{error}</Alert>}
      </div>
    </details>
  );
}
