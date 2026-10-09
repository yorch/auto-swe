'use client';

import { ciTriggerMismatch } from '@auto-swe/shared/lib/ciTrigger';
import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { SchemaFieldInput, validatePayload } from '@/components/workflow/schemaForm';
import {
  type CiTrigger,
  type CiTriggerEvent,
  type CiTriggerInput,
  type CiTriggerTemplate,
  useCiTriggerFires,
  useCiTriggers,
  useCiTriggerTemplates,
  useCreateCiTrigger,
  useDeleteCiTrigger,
  useUpdateCiTrigger,
} from '@/hooks/useCiTriggers';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';

const OUTCOME_TONE: Record<string, BadgeTone> = { FAILED_TO_START: 'brick', STARTED: 'moss' };

/** A comma- or newline-separated list of globs, trimmed, empties dropped. */
function splitPatterns(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** What a trigger will do, in a few words, from the options it sets over the defaults. */
function optionSummary(trigger: CiTrigger, template: CiTriggerTemplate | undefined): string {
  const value = (k: string) => trigger.inputs[k] ?? template?.options.properties[k]?.default;
  const parts: string[] = [];
  const mode = value('mode');
  if (mode === 'fix') {
    parts.push('Diagnose and draft a fix');
    const confidence = value('minFixConfidence');
    if (typeof confidence === 'number') {
      parts.push(`at confidence ≥ ${confidence}`);
    }
  } else if (mode === 'triage') {
    parts.push('Diagnose only');
  }
  if (value('commentOnPullRequest') === true) {
    parts.push('comments on pull requests');
  }
  return parts.join(' · ');
}

function TriggerFires({ repoId, triggerId }: { repoId: string; triggerId: string }) {
  const { data, isLoading, isError, error } = useCiTriggerFires(repoId, triggerId);
  if (isLoading) {
    return <SkeletonRows rows={2} />;
  }
  if (isError) {
    return <Alert>{errMsg(error, 'Could not load what this trigger decided.')}</Alert>;
  }
  if (!data || data.length === 0) {
    return <p className="text-paper-500 text-xs">No failed run has matched this trigger yet.</p>;
  }
  return (
    <ul className="divide-y divide-ink-600 text-xs">
      {data.map((f) => (
        <li className="flex items-start justify-between gap-3 py-2" key={f.id}>
          <div className="min-w-0">
            <div className="truncate text-paper-200">
              {f.workflowPath} on {f.headBranch}
              {f.pullRequestNumber !== null && ` (PR #${f.pullRequestNumber})`}
            </div>
            <div className="mt-0.5 text-paper-500">
              {f.event} · run {f.githubRunId}/{f.runAttempt} · {f.headSha.slice(0, 7)}
              {f.reason && ` · ${f.reason}`}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone={OUTCOME_TONE[f.outcome] ?? 'amber'} variant="outline">
              {f.outcome.replace(/_/g, ' ').toLowerCase()}
            </Badge>
            <RelativeTime className="text-paper-500" value={f.createdAt} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function TriggerRow({
  repoId,
  trigger,
  template,
  canManage,
  onEdit,
  onRemove,
}: {
  repoId: string;
  trigger: CiTrigger;
  template: CiTriggerTemplate | undefined;
  canManage: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const update = useUpdateCiTrigger(repoId);
  const [showFires, setShowFires] = useState(false);
  const items: ActionMenuItem[] = [
    {
      icon: 'list',
      id: 'fires',
      label: showFires ? 'Hide decisions' : 'Recent decisions',
      onAction: () => setShowFires((v) => !v),
    },
    ...(canManage
      ? [
          { icon: 'edit' as const, id: 'edit', label: 'Edit', onAction: onEdit },
          {
            icon: 'trash' as const,
            id: 'remove',
            label: 'Remove',
            onAction: onRemove,
            tone: 'danger' as const,
          },
        ]
      : []),
  ];
  const summary = optionSummary(trigger, template);
  return (
    <li className="px-3.5 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-paper-100">{trigger.name}</div>
          <div className="mt-0.5 text-paper-500 text-xs">
            {trigger.events.join(' + ')} · branches {trigger.branchPatterns.join(', ')} · workflows{' '}
            {trigger.workflowPatterns.join(', ')}
          </div>
          <div className="mt-0.5 text-paper-500 text-xs">
            {summary && `${summary} · `}cooldown {trigger.cooldownMinutes} min · at most{' '}
            {trigger.maxRunsPerDay} a day
            {trigger.template && ` · template ${trigger.template.name}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ToggleSwitch
            ariaLabel={`${trigger.enabled ? 'Disable' : 'Enable'} ${trigger.name}`}
            checked={trigger.enabled}
            disabled={!canManage || update.isPending}
            onChange={() => update.mutate({ enabled: !trigger.enabled, id: trigger.id })}
          />
          <ActionMenu items={items} label={`Actions for ${trigger.name}`} />
        </div>
      </div>
      {update.isError && (
        <Alert className="mt-2">{errMsg(update.error, 'Could not change the trigger.')}</Alert>
      )}
      {showFires && (
        <div className="mt-3 rounded-md border border-ink-600 px-3 py-1">
          <TriggerFires repoId={repoId} triggerId={trigger.id} />
        </div>
      )}
    </li>
  );
}

/**
 * "Would this trigger react to a failure on …?" — answered with the gateway's own matcher,
 * so what it says is what a webhook gets.
 */
function MatchTester({
  events,
  branchPatterns,
  workflowPatterns,
}: {
  events: CiTriggerEvent[];
  branchPatterns: string[];
  workflowPatterns: string[];
}) {
  const [event, setEvent] = useState<CiTriggerEvent>('push');
  const [branch, setBranch] = useState('main');
  const [workflowPath, setWorkflowPath] = useState('.github/workflows/ci.yml');
  const mismatch =
    branchPatterns.length === 0 || workflowPatterns.length === 0
      ? 'the trigger needs at least one branch and one workflow pattern'
      : ciTriggerMismatch(
          { branchPatterns, enabled: true, events, workflowPatterns },
          { branch: branch.trim(), event, workflowPath: workflowPath.trim() }
        );
  return (
    <div className="space-y-2 rounded-md border border-ink-600 px-3 py-2.5">
      <div className="font-medium text-paper-200 text-xs">Try it against a failure</div>
      <div className="grid gap-2 sm:grid-cols-[auto_1fr_1fr]">
        <Select
          compact
          label="Event"
          onChange={(v) => setEvent(v as CiTriggerEvent)}
          options={[
            { label: 'Push', value: 'push' },
            { label: 'Pull request', value: 'pull_request' },
          ]}
          value={event}
        />
        <Input compact label="Branch" onChange={(e) => setBranch(e.target.value)} value={branch} />
        <Input
          compact
          label="Workflow file"
          onChange={(e) => setWorkflowPath(e.target.value)}
          value={workflowPath}
        />
      </div>
      <p aria-live="polite" className="text-xs">
        {mismatch === null ? (
          <span className="text-moss-400">
            Would start a run — unless the cooldown, the daily cap, an earlier run on the branch or
            the budget holds it back.
          </span>
        ) : (
          <span className="text-paper-400">Would not start a run: {mismatch}.</span>
        )}
      </p>
    </div>
  );
}

type FormState = {
  name: string;
  push: boolean;
  pullRequest: boolean;
  branches: string;
  workflows: string;
  cooldown: string;
  dailyCap: string;
  templateId: string | null;
  options: Record<string, unknown>;
};

/** The form's starting option values: the template defaults, then what the trigger sets. */
function startingOptions(options: InputSchema | undefined, inputs: Record<string, unknown>) {
  const values: Record<string, unknown> = {};
  for (const [k, prop] of Object.entries(options?.properties ?? {})) {
    if (prop.default !== undefined) {
      values[k] = Array.isArray(prop.default) ? [...prop.default] : prop.default;
    }
  }
  return { ...values, ...inputs };
}

/**
 * Only the options that differ from the template's default are saved: an option left at its
 * default follows the template, so a later change of default reaches the trigger.
 */
function changedOptions(options: InputSchema | undefined, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, prop] of Object.entries(options?.properties ?? {})) {
    const v = values[k];
    if (v === undefined || v === '') {
      continue;
    }
    if (JSON.stringify(v) !== JSON.stringify(prop.default)) {
      out[k] = v;
    }
  }
  return out;
}

function formFrom(trigger: CiTrigger | undefined, template: CiTriggerTemplate | undefined) {
  return {
    branches: trigger ? trigger.branchPatterns.join(', ') : 'main, release/*',
    cooldown: String(trigger?.cooldownMinutes ?? 30),
    dailyCap: String(trigger?.maxRunsPerDay ?? 10),
    name: trigger?.name ?? '',
    options: startingOptions(template?.options, trigger?.inputs ?? {}),
    pullRequest: trigger ? trigger.events.includes('pull_request') : false,
    push: trigger ? trigger.events.includes('push') : true,
    templateId: trigger?.templateId ?? null,
    workflows: trigger ? trigger.workflowPatterns.join(', ') : '.github/workflows/**',
  } satisfies FormState;
}

/**
 * Create a trigger, or — given `trigger` — edit one. WHEN it fires (events, branches,
 * workflow files), WHAT it starts (a template and that template's own options, rendered from
 * its declared input schema) and the GUARDS on it (cooldown, daily cap).
 */
function TriggerEditor({
  repoId,
  trigger,
  templates,
  onDone,
}: {
  repoId: string;
  trigger?: CiTrigger;
  templates: CiTriggerTemplate[];
  onDone: () => void;
}) {
  const create = useCreateCiTrigger(repoId);
  const update = useUpdateCiTrigger(repoId);
  const builtIn = templates.find((t) => t.builtIn);
  const templateFor = (id: string | null) =>
    id === null ? builtIn : templates.find((t) => t.id === id);
  const [form, setForm] = useState<FormState>(() =>
    formFrom(trigger, templateFor(trigger?.templateId ?? null))
  );
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const template = templateFor(form.templateId);
  const optionErrors = template ? validatePayload(template.options, form.options) : {};

  const events: CiTriggerEvent[] = [
    ...(form.push ? (['push'] as const) : []),
    ...(form.pullRequest ? (['pull_request'] as const) : []),
  ];
  const body: CiTriggerInput = {
    branchPatterns: splitPatterns(form.branches),
    cooldownMinutes: Number(form.cooldown),
    enabled: true,
    events,
    inputs: changedOptions(template?.options, form.options),
    maxRunsPerDay: Number(form.dailyCap),
    name: form.name.trim(),
    templateId: form.templateId,
    workflowPatterns: splitPatterns(form.workflows),
  };
  const valid =
    template !== undefined &&
    body.name !== '' &&
    events.length > 0 &&
    body.branchPatterns.length > 0 &&
    body.workflowPatterns.length > 0 &&
    Number.isInteger(body.cooldownMinutes) &&
    body.cooldownMinutes >= 0 &&
    Number.isInteger(body.maxRunsPerDay) &&
    body.maxRunsPerDay >= 1 &&
    Object.keys(optionErrors).length === 0;
  const saving = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const save = () => {
    if (trigger) {
      // The on/off switch is the row's: a save never sends it, so switching the trigger while
      // the editor is open is not undone by the editor's stale copy.
      const { enabled: _enabled, ...changes } = body;
      update.mutate({ id: trigger.id, ...changes }, { onSuccess: onDone });
    } else {
      create.mutate(body, { onSuccess: onDone });
    }
  };
  const fixing = form.options.mode === 'fix';

  return (
    <section className="space-y-4 border-ink-600 border-t pt-4">
      <h4 className="font-semibold text-paper-100 text-sm">
        {trigger ? `Edit “${trigger.name}”` : 'Add a trigger'}
      </h4>
      <Input label="Name" onChange={(e) => set('name', e.target.value)} value={form.name} />

      <fieldset className="space-y-3">
        <legend className="label-mono mb-1 block">When a run fails</legend>
        <div className="flex flex-wrap gap-4">
          <Checkbox
            checked={form.push}
            label="Pushes"
            onChange={(e) => set('push', e.target.checked)}
          />
          <Checkbox
            checked={form.pullRequest}
            label="Pull requests from this repository"
            onChange={(e) => set('pullRequest', e.target.checked)}
          />
        </div>
        <Input
          hint="Globs, comma-separated. * stays within a path segment, ** crosses them, !pattern excludes; the last match wins."
          label="Branches"
          onChange={(e) => set('branches', e.target.value)}
          value={form.branches}
        />
        <Input
          hint="Globs over the workflow file path, never its display name."
          label="Workflow files"
          onChange={(e) => set('workflows', e.target.value)}
          value={form.workflows}
        />
        <MatchTester
          branchPatterns={body.branchPatterns}
          events={events}
          workflowPatterns={body.workflowPatterns}
        />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="label-mono mb-1 block">What it starts</legend>
        <Select
          hint={template?.description || undefined}
          label="Template"
          onChange={(v) => {
            const id = v === '' ? null : v;
            // The options are the new template's own: start from its defaults.
            setForm((f) => ({
              ...f,
              options: startingOptions(templateFor(id)?.options, {}),
              templateId: id,
            }));
          }}
          options={[
            { label: `${builtIn?.name ?? 'ci-triage-and-fix'} (built-in)`, value: '' },
            ...templates.filter((t) => !t.builtIn).map((t) => ({ label: t.name, value: t.id })),
          ]}
          value={form.templateId ?? ''}
        />
        {template === undefined && (
          <Alert>
            {form.templateId === null
              ? 'The built-in CI triage template is not installed.'
              : 'This template can no longer be started by a trigger; choose another.'}
          </Alert>
        )}
        {template &&
          Object.entries(template.options.properties).map(([k, prop]) => (
            <SchemaFieldInput
              error={optionErrors[k]}
              key={`${form.templateId ?? 'builtin'}:${k}`}
              name={k}
              onChange={(v) => set('options', { ...form.options, [k]: v })}
              prop={prop}
              required={template.options.required?.includes(k)}
              value={form.options[k]}
            />
          ))}
        {fixing && (
          <p className="text-paper-500 text-xs">
            A fix is always a draft pull request into the failing branch — a pull request's own
            branch when the failure came from one. Nothing is merged or pushed to that branch.
          </p>
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="label-mono mb-1 block">Limits</legend>
        <div className="flex flex-wrap gap-3">
          <Input
            hint="No new run on the same branch within this long of the last."
            label="Cooldown (minutes)"
            min={0}
            onChange={(e) => set('cooldown', e.target.value)}
            type="number"
            value={form.cooldown}
          />
          <Input
            label="Runs per day"
            min={1}
            onChange={(e) => set('dailyCap', e.target.value)}
            type="number"
            value={form.dailyCap}
          />
        </div>
      </fieldset>

      {error && <Alert>{errMsg(error, 'Could not save the trigger — check the patterns.')}</Alert>}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone} variant="ghost">
          Cancel
        </Button>
        <Button disabled={!valid || saving} onClick={save} variant="primary">
          <Icon name={trigger ? 'check' : 'plus'} size={14} />
          {trigger ? 'Save' : 'Add'}
        </Button>
      </div>
    </section>
  );
}

/**
 * A repository's CI-failure triggers: which failed GitHub Actions runs start the CI triage
 * template, and what each trigger decided (docs/ci-failure-triggers.md). Members read; the
 * owning team's leads and admins manage — the server answers `canManage`.
 */
export function CiTriggersModal({
  repo,
  onClose,
}: {
  repo: RepositorySummary;
  onClose: () => void;
}) {
  const { data, isLoading, isError, error } = useCiTriggers(repo.id);
  // Only those who may manage the triggers may list the templates they could start.
  const templates = useCiTriggerTemplates(repo.id, data?.canManage === true);
  const remove = useDeleteCiTrigger(repo.id);
  const [pendingRemove, setPendingRemove] = useState<CiTrigger | null>(null);
  // null: list only; 'new': adding; a trigger: editing it.
  const [editing, setEditing] = useState<CiTrigger | 'new' | null>(null);
  const canManage = data?.canManage ?? false;
  const templateList = templates.data ?? [];
  const templateOf = (t: CiTrigger) =>
    t.templateId === null
      ? templateList.find((x) => x.builtIn)
      : templateList.find((x) => x.id === t.templateId);

  return (
    <>
      <Modal
        eyebrow="CI-failure triggers"
        onClose={onClose}
        open
        size="lg"
        subtitle="When a GitHub Actions run on this repository fails and a trigger matches, the platform diagnoses it — and, in fix mode, opens a draft fix into the failing branch."
        title={connectionLabel(repo)}
      >
        {isLoading ? (
          <SkeletonRows rows={3} />
        ) : isError ? (
          <Alert>{errMsg(error, 'Could not load the triggers for this repository.')}</Alert>
        ) : (
          <div className="space-y-5">
            {remove.isError && (
              <Alert>{errMsg(remove.error, 'Could not remove the trigger.')}</Alert>
            )}
            {data && data.triggers.length > 0 ? (
              <ul className="divide-y divide-ink-600 rounded-lg border border-ink-500/70 bg-ink-900/40">
                {data.triggers.map((t) => (
                  <TriggerRow
                    canManage={canManage}
                    key={t.id}
                    onEdit={() => setEditing(t)}
                    onRemove={() => setPendingRemove(t)}
                    repoId={repo.id}
                    template={templateOf(t)}
                    trigger={t}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-paper-500 text-sm">
                No triggers: a failed run on this repository starts nothing.
              </p>
            )}
            {canManage &&
              (editing === null ? (
                <Button onClick={() => setEditing('new')} variant="secondary">
                  <Icon name="plus" size={14} />
                  Add a trigger
                </Button>
              ) : templates.isLoading ? (
                <SkeletonRows rows={3} />
              ) : templates.isError ? (
                <Alert>{errMsg(templates.error, 'Could not load the templates.')}</Alert>
              ) : (
                <TriggerEditor
                  key={editing === 'new' ? 'new' : editing.id}
                  onDone={() => setEditing(null)}
                  repoId={repo.id}
                  templates={templateList}
                  trigger={editing === 'new' ? undefined : editing}
                />
              ))}
          </div>
        )}
        <ModalFooter cancelLabel="Close" onCancel={onClose} />
      </Modal>
      {pendingRemove && (
        <ConfirmModal
          confirmLabel="Remove"
          dangerous
          message={`Remove "${pendingRemove.name}"? Its decision history is deleted with it.`}
          onClose={() => setPendingRemove(null)}
          onConfirm={() => remove.mutate(pendingRemove.id)}
          open
          title="Remove trigger"
        />
      )}
    </>
  );
}
