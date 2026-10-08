'use client';

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
import {
  type CiTrigger,
  type CiTriggerEvent,
  type CiTriggerInput,
  type CiTriggerMode,
  useCiTriggerFires,
  useCiTriggers,
  useCreateCiTrigger,
  useDeleteCiTrigger,
  useUpdateCiTrigger,
} from '@/hooks/useCiTriggers';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';

const MODE_LABEL: Record<CiTriggerMode, string> = {
  FIX: 'Diagnose and draft a fix',
  TRIAGE_ONLY: 'Diagnose only',
};

const OUTCOME_TONE: Record<string, BadgeTone> = { FAILED_TO_START: 'brick', STARTED: 'moss' };

/** A comma- or newline-separated list of globs, trimmed, empties dropped. */
function splitPatterns(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
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
  canManage,
  onRemove,
}: {
  repoId: string;
  trigger: CiTrigger;
  canManage: boolean;
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
            {MODE_LABEL[trigger.mode]} · cooldown {trigger.cooldownMinutes} min · at most{' '}
            {trigger.maxRunsPerDay} a day
            {trigger.commentOnPullRequest && ' · comments on pull requests'}
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

const EMPTY_FORM = {
  branches: 'main, release/*',
  comment: true,
  cooldown: '30',
  dailyCap: '10',
  mode: 'TRIAGE_ONLY' as CiTriggerMode,
  name: '',
  pullRequest: false,
  push: true,
  workflows: '.github/workflows/**',
};

function NewTriggerForm({ repoId }: { repoId: string }) {
  const create = useCreateCiTrigger(repoId);
  const [form, setForm] = useState(EMPTY_FORM);
  const set = <K extends keyof typeof EMPTY_FORM>(k: K, v: (typeof EMPTY_FORM)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const events: CiTriggerEvent[] = [
    ...(form.push ? (['push'] as const) : []),
    ...(form.pullRequest ? (['pull_request'] as const) : []),
  ];
  const body: CiTriggerInput = {
    branchPatterns: splitPatterns(form.branches),
    commentOnPullRequest: form.comment,
    cooldownMinutes: Number(form.cooldown),
    enabled: true,
    events,
    maxRunsPerDay: Number(form.dailyCap),
    mode: form.mode,
    name: form.name.trim(),
    workflowPatterns: splitPatterns(form.workflows),
  };
  const valid =
    body.name !== '' &&
    events.length > 0 &&
    body.branchPatterns.length > 0 &&
    body.workflowPatterns.length > 0 &&
    Number.isInteger(body.cooldownMinutes) &&
    Number.isInteger(body.maxRunsPerDay) &&
    body.maxRunsPerDay >= 1;

  return (
    <section className="space-y-3 border-ink-600 border-t pt-4">
      <h4 className="font-semibold text-paper-100 text-sm">Add a trigger</h4>
      <Input label="Name" onChange={(e) => set('name', e.target.value)} value={form.name} />
      <Input
        hint="Globs, comma-separated. * stays within a path segment, ** crosses them, !pattern excludes."
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
        <Checkbox
          checked={form.comment}
          label="Post the diagnosis on the pull request"
          onChange={(e) => set('comment', e.target.checked)}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Select
          hint="A fix is always a draft pull request into the failing branch."
          label="Mode"
          onChange={(v) => set('mode', v as CiTriggerMode)}
          options={(Object.keys(MODE_LABEL) as CiTriggerMode[]).map((m) => ({
            label: MODE_LABEL[m],
            value: m,
          }))}
          value={form.mode}
        />
        <Input
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
        <Button
          disabled={!valid || create.isPending}
          onClick={() => create.mutate(body, { onSuccess: () => setForm(EMPTY_FORM) })}
          variant="primary"
        >
          <Icon name="plus" size={14} />
          Add
        </Button>
      </div>
      {create.isError && (
        <Alert>{errMsg(create.error, 'Could not add the trigger — check the patterns.')}</Alert>
      )}
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
  const remove = useDeleteCiTrigger(repo.id);
  const [pendingRemove, setPendingRemove] = useState<CiTrigger | null>(null);
  const canManage = data?.canManage ?? false;

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
                    onRemove={() => setPendingRemove(t)}
                    repoId={repo.id}
                    trigger={t}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-paper-500 text-sm">
                No triggers: a failed run on this repository starts nothing.
              </p>
            )}
            {canManage && <NewTriggerForm repoId={repo.id} />}
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
