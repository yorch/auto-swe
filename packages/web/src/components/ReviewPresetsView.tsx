'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable } from '@/components/ui/DataTable';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  type ReviewPreset,
  useDeleteReviewPreset,
  useReviewAttachment,
  useReviewChoices,
  useReviewPresets,
  useReviewRepositories,
  useSaveReviewPreset,
} from '@/hooks/useCodeReview';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';

function PresetForm({
  preset,
  onClose,
  teamId,
}: {
  preset: ReviewPreset | null;
  onClose: () => void;
  teamId?: string;
}) {
  const choices = useReviewChoices(true, { teamId });
  const save = useSaveReviewPreset(teamId);
  const [name, setName] = useState(preset?.name ?? '');
  const [description, setDescription] = useState(preset?.description ?? '');
  const [templateId, setTemplate] = useState(preset?.templateId ?? '');
  const [prompt, setPrompt] = useState(preset?.systemPrompt ?? '');
  const [onBlocking, setBlocking] = useState<'report' | 'fix'>(preset?.onBlocking ?? 'report');
  const [enabled, setEnabled] = useState(preset?.enabled ?? true);
  const [runTests, setRunTests] = useState(preset?.runTests ?? false);
  const templates = [...(choices.data?.templates ?? [])];
  if (preset && !templates.some((t) => t.id === preset.templateId)) {
    templates.push(preset.template);
  }
  const selected = templateId || templates[0]?.id || '';
  return (
    <Modal
      onClose={() => {
        if (!save.isPending) {
          onClose();
        }
      }}
      open
      title={preset ? 'Edit review preset' : 'New review preset'}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !selected || save.isPending) {
            return;
          }
          save.mutate(
            {
              body: {
                description,
                enabled,
                name: name.trim(),
                onBlocking,
                runTests,
                systemPrompt: prompt.trim() ? prompt : null,
                templateId: selected,
              },
              id: preset?.id,
            },
            { onSuccess: onClose }
          );
        }}
      >
        <Input
          label="Name"
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          required
          value={name}
        />
        <Textarea
          label="Description"
          maxLength={4000}
          onChange={(e) => setDescription(e.target.value)}
          value={description}
        />
        <QueryBoundary {...choices} label="review templates" onRetry={() => choices.refetch()}>
          <Select
            label="Review template"
            onChange={setTemplate}
            options={templates.map((t) => ({ label: t.name, value: t.id }))}
            value={selected}
          />
          {!templates.length && (
            <p className="text-sm text-paper-500">
              No active review templates are available. Mark a template as a review in its metadata
              settings first.
            </p>
          )}
        </QueryBoundary>
        <Textarea
          hint="Optional instructions for the review network."
          label="Reviewer system prompt"
          maxLength={100000}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          value={prompt}
        />
        <Select
          label="On blocking findings"
          onChange={(v) => setBlocking(v as 'report' | 'fix')}
          options={[
            { label: 'Report only', value: 'report' },
            { label: 'Request a fix round', value: 'fix' },
          ]}
          value={onBlocking}
        />
        <p className="text-sm text-paper-400">
          PR fixes require an enabled repository feedback automation opted in to{' '}
          <code>review_findings</code>, using the default address-pr-feedback template, and the
          pull-request feedback automation setting enabled. Existing round limits and push rules
          apply. Verified stored changes use a same-agent follow-up with no delivery.
        </p>
        <ToggleSwitch checked={enabled} label="Enabled" onChange={() => setEnabled(!enabled)} />
        <Checkbox
          checked={runTests}
          label="Run repository tests before review"
          onChange={(e) => setRunTests(e.target.checked)}
        />
        {save.error && <Alert>{errMsg(save.error)}</Alert>}
        <ModalFooter
          disabled={!name.trim() || !selected || choices.isError || choices.isLoading}
          isPending={save.isPending}
          onCancel={onClose}
          submitLabel="Save preset"
        />
      </form>
    </Modal>
  );
}

function Attachments({
  preset,
  onClose,
  teamId,
}: {
  preset: ReviewPreset;
  onClose: () => void;
  teamId?: string;
}) {
  const templates = useWorkflowTemplates(teamId);
  const repositories = useReviewRepositories(teamId);
  const mutation = useReviewAttachment(teamId);
  const [kind, setKind] = useState('template');
  const [target, setTarget] = useState('');
  const query = kind === 'template' ? templates : repositories;
  const options =
    kind === 'template'
      ? (templates.data ?? [])
          .filter((t) => !teamId || t.team?.id === teamId)
          .map((t) => ({ label: t.name, value: t.id }))
      : (repositories.data ?? []).map((r) => ({
          label: `${r.organizationName}/${r.repoName}`,
          value: r.id,
        }));
  return (
    <Modal
      onClose={() => {
        if (!mutation.isPending) {
          onClose();
        }
      }}
      open
      title={`Attachments: ${preset.name}`}
    >
      <div className="space-y-4">
        <p className="text-sm text-paper-400">
          Automatically review successful runs of the attached workflow template or repository.
        </p>
        <DataTable
          actions={(a) => (
            <Button
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate({
                  id: preset.id,
                  remove: true,
                  target: a.templateId
                    ? { templateId: a.templateId }
                    : { connectionId: a.connectionId ?? '' },
                })
              }
              variant="ghost"
            >
              Remove
            </Button>
          )}
          caption="Preset attachments"
          columns={[
            {
              cell: (a) =>
                a.templateId
                  ? `Workflow: ${templates.data?.find((t) => t.id === a.templateId)?.name ?? a.templateId}`
                  : `Repository: ${repositories.data?.find((r) => r.id === a.connectionId)?.repoName ?? a.connectionId}`,
              header: 'Source',
              id: 'target',
              primary: true,
            },
          ]}
          empty={<p>No attachments.</p>}
          getRowId={(a) => a.id}
          rows={preset.attachments}
        />
        <Select
          label="Attachment type"
          onChange={(v) => {
            setKind(v);
            setTarget('');
            mutation.reset();
          }}
          options={[
            { label: 'Workflow template', value: 'template' },
            { label: 'Repository', value: 'repository' },
          ]}
          value={kind}
        />
        <QueryBoundary {...query} label="attachment sources" onRetry={() => query.refetch()}>
          <Combobox label="Source" onChange={setTarget} options={options} value={target} />
          {!options.length && <p>No attachment sources are available.</p>}
        </QueryBoundary>
        {mutation.error && <Alert>{errMsg(mutation.error)}</Alert>}
        <Button
          disabled={!target || query.isError || query.isLoading || mutation.isPending}
          onClick={() =>
            mutation.mutate(
              {
                id: preset.id,
                target: kind === 'template' ? { templateId: target } : { connectionId: target },
              },
              { onSuccess: () => setTarget('') }
            )
          }
        >
          Add attachment
        </Button>
        <ModalFooter isPending={mutation.isPending} onCancel={onClose} />
      </div>
    </Modal>
  );
}

export default function ReviewPresetsPage() {
  return <ReviewPresetsView />;
}
export function ReviewPresetsView({ teamId }: { teamId?: string }) {
  const query = useReviewPresets(teamId);
  const remove = useDeleteReviewPreset(teamId);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ReviewPreset | null>(null);
  const [deleting, setDeleting] = useState<ReviewPreset | null>(null);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const attached = query.data?.find((p) => p.id === attachmentId);
  return (
    <div className="space-y-6">
      <PageHeader
        actions={<Button onClick={() => setCreating(true)}>New preset</Button>}
        subtitle="Reusable review policies and automatic review attachments."
        title={teamId ? 'Team review presets' : 'Review presets'}
      />
      <QueryBoundary {...query} label="review presets" onRetry={() => query.refetch()}>
        <DataTable
          actions={(p) => (
            <div className="flex gap-2">
              <Button onClick={() => setEditing(p)} variant="ghost">
                Edit
              </Button>
              <Button onClick={() => setAttachmentId(p.id)} variant="ghost">
                Attachments ({p.attachments.length})
              </Button>
              <Button onClick={() => setDeleting(p)} variant="ghost">
                Delete
              </Button>
            </div>
          )}
          caption="Review presets"
          columns={[
            {
              cell: (p) => (p.teamId ? `Team: ${p.teamId}` : 'Global'),
              header: 'Scope',
              id: 'scope',
            },
            {
              cell: (p) => p.name,
              header: 'Name',
              id: 'name',
              primary: true,
              secondary: (p) => p.description,
            },
            { cell: (p) => p.template.name, header: 'Template', id: 'template' },
            { cell: (p) => p.onBlocking, header: 'On blocking', id: 'policy' },
            { cell: (p) => (p.enabled ? 'Yes' : 'No'), header: 'Enabled', id: 'enabled' },
          ]}
          empty={<p>No review presets. Create a preset to configure reusable reviews.</p>}
          getRowId={(p) => p.id}
          rows={query.data ?? []}
        />
      </QueryBoundary>
      {(creating || editing) && (
        <PresetForm
          key={editing?.id ?? 'new'}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          preset={editing}
          teamId={teamId}
        />
      )}
      {attached && (
        <Attachments onClose={() => setAttachmentId(null)} preset={attached} teamId={teamId} />
      )}
      <ConfirmModal
        confirmLabel="Delete preset"
        dangerous
        message={`Delete ${deleting?.name ?? 'this preset'} and its automatic review attachments? Existing review runs are kept.`}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) {
            await remove.mutateAsync(deleting.id);
          }
        }}
        open={Boolean(deleting)}
        title="Delete review preset?"
      />
    </div>
  );
}
