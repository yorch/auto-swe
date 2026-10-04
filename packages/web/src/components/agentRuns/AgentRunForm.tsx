'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useAgentRunAgents, useAgentRunLimits, useLaunchAgentRun } from '@/hooks/useAgentRuns';
import { useRepositories } from '@/hooks/useRepositories';
import { useRetriedRun } from '@/hooks/useRuns';
import {
  AGENT_RUN_MAX_PROMPT_CHARS,
  type AgentRunDeliver,
  type AgentRunFormErrors,
  type AgentRunFormValues,
  buildLaunchBody,
  DELIVER_OPTIONS,
  describeLaunchError,
  type IdempotencyState,
  idempotencyFor,
  validateAgentRunForm,
} from '@/lib/agentRun';
import { connectionLabel } from '@/lib/connectionDisplay';

const LATEST = 'latest';

const EMPTY: AgentRunFormValues = {
  agentKey: '',
  deliver: 'none',
  maxSteps: '',
  maxWallClockSeconds: '',
  pinnedVersion: null,
  prompt: '',
  repoId: '',
};

export function AgentRunForm({
  reviewBeforeLaunch = false,
  onLaunched,
}: {
  reviewBeforeLaunch?: boolean;
  onLaunched?: (requestId: string) => void;
} = {}) {
  const [reviewing, setReviewing] = useState(false);
  const [values, setValues] = useState<AgentRunFormValues>(EMPTY);
  const [attempted, setAttempted] = useState(false);
  // One idempotency key per distinct submission; see `idempotencyFor`.
  const idempotency = useRef<IdempotencyState | null>(null);
  const submitting = useRef(false);

  const repos = useRepositories({ limit: 500 });
  const repoId = values.repoId || null;
  const agents = useAgentRunAgents(repoId);
  const limits = useAgentRunLimits(repoId);
  const launch = useLaunchAgentRun();
  const launched = launch.data ?? null;
  const started = useRetriedRun(
    launched?.workRequestId ?? null,
    launched?.temporalWorkflowId ?? null
  );

  const gitRepos = (repos.data ?? []).filter((r) => r.type === 'git_repo');
  const agentList = agents.data ?? [];
  // A repository change can drop the chosen agent (an org's overrides differ).
  const agent = agentList.find((a) => a.key === values.agentKey);
  const effective: AgentRunFormValues = {
    ...values,
    agentKey: agent ? values.agentKey : '',
    pinnedVersion:
      agent &&
      values.pinnedVersion !== null &&
      agent.pinnableVersions.includes(values.pinnedVersion)
        ? values.pinnedVersion
        : null,
  };
  const errors: AgentRunFormErrors = validateAgentRunForm(effective, limits.data);
  const disabledByPlatform = limits.data !== undefined && !limits.data.enabled;
  const canSubmit = !launch.isPending && !disabledByPlatform;

  const set = <K extends keyof AgentRunFormValues>(key: K, value: AgentRunFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    // A launch error is about the values it was sent with.
    if (launch.isError) {
      launch.reset();
    }
  };

  const submit = () => {
    setAttempted(true);
    // `isPending` lags a click by a render, so a double click needs its own guard: a
    // second mutate would replace the first's observer and could show "already started".
    if (Object.keys(errors).length > 0 || !canSubmit || submitting.current) {
      return;
    }
    submitting.current = true;
    const body = buildLaunchBody(effective);
    idempotency.current = idempotencyFor(idempotency.current, body);
    launch.mutate(
      { body, idempotencyKey: idempotency.current.key },
      {
        // A launched run is done with its key: launching the same text again is a new run.
        onSettled: () => {
          submitting.current = false;
        },
        onSuccess: (result) => {
          onLaunched?.(result.workRequestId);
          idempotency.current = null;
        },
      }
    );
  };

  const show = (k: keyof AgentRunFormErrors) => (attempted ? errors[k] : undefined);

  if (launched) {
    return (
      <Card className="space-y-4 p-6">
        <Alert variant="success">Agent run started.</Alert>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <dt className="label-mono">Delivery</dt>
          <dd className="text-paper-300">
            {DELIVER_OPTIONS.find((o) => o.value === launched.effective.deliver)?.label}
          </dd>
          <dt className="label-mono">Step limit</dt>
          <dd className="font-mono text-paper-300">{launched.effective.maxSteps}</dd>
          <dt className="label-mono">Time limit</dt>
          <dd className="font-mono text-paper-300">{launched.effective.maxWallClockSeconds} s</dd>
        </dl>
        <div className="flex items-center gap-3">
          {started.runId ? (
            <Link className="text-ember-400 hover:underline" href={`/runs/${started.runId}`}>
              View the run →
            </Link>
          ) : started.timedOut ? (
            <Link className="text-ember-400 hover:underline" href="/runs">
              View runs →
            </Link>
          ) : (
            <span className="text-paper-500 text-[13px]">Locating the run…</span>
          )}
          <Button
            onClick={() => {
              launch.reset();
              setAttempted(false);
              setValues((v) => ({ ...v, prompt: '' }));
            }}
            size="sm"
            variant="secondary"
          >
            Run another
          </Button>
        </div>
      </Card>
    );
  }

  const selectedRepo = gitRepos.find((repo) => repo.id === values.repoId);
  if (reviewBeforeLaunch && reviewing) {
    const failure = launch.isError ? describeLaunchError(launch.error) : null;
    return (
      <Card className="space-y-5">
        <h2 className="text-lg font-semibold">Review and launch</h2>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-paper-400">Repository</dt>
            <dd>{selectedRepo ? connectionLabel(selectedRepo) : values.repoId}</dd>
          </div>
          <div>
            <dt className="text-paper-400">Agent</dt>
            <dd>
              {agent?.name}{' '}
              {effective.pinnedVersion !== null ? `· v${effective.pinnedVersion}` : '· latest'}
            </dd>
          </div>
          <div>
            <dt className="text-paper-400">Task</dt>
            <dd className="whitespace-pre-wrap break-words">{values.prompt}</dd>
          </div>
          <div>
            <dt className="text-paper-400">Delivery</dt>
            <dd>{DELIVER_OPTIONS.find((option) => option.value === values.deliver)?.label}</dd>
          </div>
          <div>
            <dt className="text-paper-400">Limits</dt>
            <dd>
              {values.maxSteps || limits.data?.maxSteps.ceiling || 'Platform default'} steps ·{' '}
              {values.maxWallClockSeconds ||
                limits.data?.maxWallClockSeconds.ceiling ||
                'Platform default'}{' '}
              seconds
            </dd>
          </div>
        </dl>
        <Alert variant="info">
          {values.deliver === 'none'
            ? 'The output stays in the temporary workspace. No branch or pull request is published.'
            : values.deliver === 'branch'
              ? 'A new branch may be pushed after checks pass.'
              : 'A new branch and draft pull request may be published after checks pass.'}{' '}
          Nothing is merged automatically.
        </Alert>
        {failure && <Alert title={failure.title}>{failure.message}</Alert>}
        <div className="flex justify-end gap-3">
          <Button disabled={launch.isPending} onClick={() => setReviewing(false)} variant="ghost">
            Back to details
          </Button>
          <Button disabled={!canSubmit} onClick={submit} variant="primary">
            {launch.isPending ? 'Starting…' : 'Launch agent'}
          </Button>
        </div>
      </Card>
    );
  }

  const launchError = launch.isError ? describeLaunchError(launch.error) : null;
  const stepsCeiling = limits.data?.maxSteps.ceiling;
  const clockCeiling = limits.data?.maxWallClockSeconds.ceiling;

  return (
    <Card className="space-y-5 p-6">
      {disabledByPlatform && (
        <Alert title="Agent runs are turned off" variant="warning">
          An administrator has disabled agent runs
          {repoId ? ' for this repository’s team or the platform' : ''}.
        </Alert>
      )}
      {launchError && (
        <Alert title={launchError.title}>
          <div>{launchError.message}</div>
          {launchError.hint && <div className="mt-1 opacity-80">{launchError.hint}</div>}
          {launchError.duplicate && (
            <Link className="mt-1 inline-block underline" href="/runs">
              View runs
            </Link>
          )}
        </Alert>
      )}

      <Combobox
        emptyMessage="No repositories match"
        error={show('repoId')}
        hint={repos.isError ? 'Could not load repositories' : 'Repositories your teams can reach'}
        label="Repository"
        onChange={(v) => set('repoId', v)}
        options={gitRepos.map((r) => ({ label: connectionLabel(r), value: r.id }))}
        placeholder={repos.isLoading ? 'Loading…' : 'Choose a repository…'}
        required
        value={values.repoId}
      />

      <Combobox
        disabled={!values.repoId}
        emptyMessage="No launchable agents"
        error={show('agentKey')}
        hint={
          agents.isError
            ? 'Could not load agents'
            : agent
              ? (agent.description ?? undefined)
              : values.repoId
                ? 'Library agents this repository can run'
                : 'Choose a repository first'
        }
        label="Agent"
        onChange={(v) => {
          setValues((s) => ({ ...s, agentKey: v, pinnedVersion: null }));
          if (launch.isError) {
            launch.reset();
          }
        }}
        options={agentList.map((a) => ({
          label: a.scope === 'ORGANIZATION' ? `${a.name} (organization)` : a.name,
          value: a.key,
        }))}
        placeholder={agents.isLoading && values.repoId ? 'Loading…' : 'Choose an agent…'}
        required
        value={effective.agentKey}
      />

      {agent && agent.pinnableVersions.length > 0 && (
        <Select
          hint={`Latest is v${agent.version}. Pinning freezes the run to one global version.`}
          label="Version"
          onChange={(v) => set('pinnedVersion', v === LATEST ? null : Number(v))}
          options={[
            { label: `Latest (v${agent.version})`, value: LATEST },
            ...agent.pinnableVersions.map((v) => ({ label: `v${v}`, value: String(v) })),
          ]}
          value={effective.pinnedVersion === null ? LATEST : String(effective.pinnedVersion)}
        />
      )}

      <Textarea
        error={show('prompt')}
        hint={`${values.prompt.length.toLocaleString('en-US')} / ${AGENT_RUN_MAX_PROMPT_CHARS.toLocaleString('en-US')}`}
        label="Prompt"
        onChange={(e) => set('prompt', e.target.value)}
        placeholder="What should the agent do?"
        required
        rows={8}
        value={values.prompt}
      />

      <RadioGroup<AgentRunDeliver>
        legend="What to do with the result"
        name="deliver"
        onChange={(v) => set('deliver', v)}
        options={DELIVER_OPTIONS}
        value={values.deliver}
      />
      {values.deliver !== 'none' && (
        <Alert variant="warning">
          The change is published only after the deterministic checks and the security gate pass.
          The pushed branch then runs the repository’s existing push-triggered CI, with its secrets,
          on code the agent wrote.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          error={show('maxSteps')}
          hint={
            stepsCeiling === undefined
              ? 'Optional. Can only lower the platform ceiling.'
              : `Optional. Platform ceiling: ${stepsCeiling}.`
          }
          inputMode="numeric"
          label="Max steps"
          onChange={(e) => set('maxSteps', e.target.value)}
          placeholder={stepsCeiling === undefined ? 'ceiling' : String(stepsCeiling)}
          value={values.maxSteps}
        />
        <Input
          error={show('maxWallClockSeconds')}
          hint={
            clockCeiling === undefined
              ? 'Optional, in seconds. Can only lower the platform ceiling.'
              : `Optional, in seconds. Platform ceiling: ${clockCeiling}.`
          }
          inputMode="numeric"
          label="Time limit (seconds)"
          onChange={(e) => set('maxWallClockSeconds', e.target.value)}
          placeholder={clockCeiling === undefined ? 'ceiling' : String(clockCeiling)}
          value={values.maxWallClockSeconds}
        />
      </div>

      <div className="flex justify-end">
        <Button
          disabled={!canSubmit}
          onClick={
            reviewBeforeLaunch
              ? () => {
                  setAttempted(true);
                  if (!Object.keys(errors).length) {
                    setReviewing(true);
                  }
                }
              : submit
          }
          size="lg"
          variant="primary"
        >
          {launch.isPending ? 'Starting…' : reviewBeforeLaunch ? 'Review agent run' : 'Run agent →'}
        </Button>
      </div>
    </Card>
  );
}
