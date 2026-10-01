'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import {
  type AutonomyPolicy,
  type AutonomyPolicyForm,
  useAutonomyPolicies,
  useCreateAutonomyPolicy,
  useDeleteAutonomyPolicy,
  useUpdateAutonomyPolicy,
} from '@/hooks/useAutonomyPolicies';
import { useTeams } from '@/hooks/useTeams';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';

type RuleRow = {
  action: 'auto' | 'require_approval';
  approverCount: string;
  id: string;
  riskClass: string;
};

type Scope = 'global' | 'team' | 'template';

type PolicyForm = {
  description: string;
  name: string;
  rules: RuleRow[];
  scope: Scope;
  teamId: string;
  templateId: string;
};

const DEFAULT_RULES: RuleRow[] = [
  {
    action: 'require_approval',
    approverCount: '1',
    id: crypto.randomUUID(),
    riskClass: 'external_communication',
  },
  { action: 'auto', approverCount: '', id: crypto.randomUUID(), riskClass: 'internal_write' },
  {
    action: 'require_approval',
    approverCount: '2',
    id: crypto.randomUUID(),
    riskClass: 'mass_communication',
  },
];

function emptyForm(): PolicyForm {
  return {
    description: '',
    name: '',
    rules: [...DEFAULT_RULES],
    scope: 'global',
    teamId: '',
    templateId: '',
  };
}

function policyToForm(policy: AutonomyPolicy): PolicyForm {
  const entries = Object.entries(policy.rules).map(([riskClass, rule]) => ({
    action: rule.action,
    approverCount: rule.approverCount?.toString() ?? '',
    id: crypto.randomUUID(),
    riskClass,
  }));
  let scope: Scope = 'global';
  if (policy.templateId) {
    scope = 'template';
  } else if (policy.teamId) {
    scope = 'team';
  }
  return {
    description: policy.description ?? '',
    name: policy.name,
    rules: entries.length > 0 ? entries : [...DEFAULT_RULES],
    scope,
    teamId: policy.teamId ?? '',
    templateId: policy.templateId ?? '',
  };
}

function formToBody(form: PolicyForm): AutonomyPolicyForm {
  const rules: AutonomyPolicyForm['rules'] = {};
  for (const r of form.rules) {
    if (!r.riskClass.trim()) {
      continue;
    }
    const value: { action: 'auto' | 'require_approval'; approverCount?: number } = {
      action: r.action,
    };
    if (r.action === 'require_approval' && r.approverCount.trim() !== '') {
      value.approverCount = Number(r.approverCount);
    }
    rules[r.riskClass.trim()] = value;
  }
  const body: AutonomyPolicyForm = { name: form.name.trim(), rules };
  if (form.description.trim()) {
    body.description = form.description.trim();
  }
  if (form.scope === 'global') {
    body.isDefault = true;
    body.teamId = null;
    body.templateId = null;
  } else if (form.scope === 'team') {
    body.isDefault = true;
    body.teamId = form.teamId || null;
    body.templateId = null;
  } else {
    body.isDefault = false;
    body.teamId = null;
    body.templateId = form.templateId || null;
  }
  return body;
}

function scopeLabel(policy: AutonomyPolicy): string {
  if (policy.template) {
    return `Template: ${policy.template.name}`;
  }
  if (policy.team) {
    return `Team default: ${policy.team.name}`;
  }
  return 'Global default';
}

// ── Policy Modal ─────────────────────────────────────────────────────────────

function PolicyModal({
  editing,
  onClose,
  open,
}: {
  editing: AutonomyPolicy | null;
  onClose: () => void;
  open: boolean;
}) {
  const { data: teams } = useTeams();
  const { data: templates } = useWorkflowTemplates();
  const create = useCreateAutonomyPolicy();
  const update = useUpdateAutonomyPolicy();
  const [form, setForm] = useState<PolicyForm>(emptyForm());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(editing ? policyToForm(editing) : emptyForm());
  }, [editing]);

  const title = editing ? 'Edit autonomy policy' : 'New autonomy policy';
  const eyebrow = 'Govern / Autonomy Policies';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!form.name.trim()) {
      setError('Name is required.');
      return;
    }

    const riskClasses = new Set<string>();
    for (const r of form.rules) {
      if (!r.riskClass.trim()) {
        continue;
      }
      if (riskClasses.has(r.riskClass.trim())) {
        setError(`Duplicate risk class: ${r.riskClass.trim()}`);
        return;
      }
      riskClasses.add(r.riskClass.trim());
    }

    if (form.scope === 'team' && !form.teamId) {
      setError('Select a team for a team default.');
      return;
    }
    if (form.scope === 'template' && !form.templateId) {
      setError('Select a template for a template override.');
      return;
    }

    try {
      const body = formToBody(form);
      if (editing) {
        await update.mutateAsync({ id: editing.id, ...body });
      } else {
        await create.mutateAsync(body);
      }
      onClose();
      setForm(emptyForm());
    } catch (err) {
      setError(errMsg(err, `Failed to ${editing ? 'update' : 'create'} policy`));
    }
  }

  function setRuleField(index: number, patch: Partial<RuleRow>) {
    setForm((f) => ({
      ...f,
      rules: f.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  }

  function addRule() {
    setForm((f) => ({
      ...f,
      rules: [
        ...f.rules,
        { action: 'auto', approverCount: '', id: crypto.randomUUID(), riskClass: '' },
      ],
    }));
  }

  function removeRule(index: number) {
    setForm((f) => ({ ...f, rules: f.rules.filter((_, i) => i !== index) }));
  }

  return (
    <Modal eyebrow={eyebrow} onClose={onClose} open={open} size="lg" title={title}>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Input
          label="Name"
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="e.g. Strict external comms"
          required
          value={form.name}
        />
        <Input
          label="Description"
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder="What this policy controls"
          value={form.description}
        />
        <Select
          label="Scope"
          onChange={(v) =>
            setForm((f) => ({
              ...f,
              scope: v as Scope,
              teamId: '',
              templateId: '',
            }))
          }
          options={[
            { label: 'Global default', value: 'global' },
            { label: 'Team default', value: 'team' },
            { label: 'Template override', value: 'template' },
          ]}
          value={form.scope}
        />
        {form.scope === 'team' && (
          <Combobox
            label="Team"
            onChange={(v) => setForm((f) => ({ ...f, teamId: v }))}
            options={(teams ?? []).map((t) => ({ label: t.name, value: t.id }))}
            placeholder="Select a team"
            value={form.teamId}
          />
        )}
        {form.scope === 'template' && (
          <Combobox
            label="Template"
            onChange={(v) => setForm((f) => ({ ...f, templateId: v }))}
            options={(templates ?? []).map((t) => ({ label: t.name, value: t.id }))}
            placeholder="Select a template"
            value={form.templateId}
          />
        )}
        <Card variant="inset">
          <CardHeader>
            <CardTitle>Risk-class rules</CardTitle>
          </CardHeader>
          <div className="space-y-3">
            {form.rules.map((r, i) => (
              <div className="grid grid-cols-[1fr_120px_80px_40px] gap-2 items-end" key={r.id}>
                <Input
                  aria-label={i === 0 ? undefined : `Risk class, rule ${i + 1}`}
                  id={`rule-${r.id}-risk-class`}
                  label={i === 0 ? 'Risk class' : undefined}
                  onChange={(e) => setRuleField(i, { riskClass: e.target.value })}
                  placeholder="e.g. external_communication"
                  value={r.riskClass}
                />
                <Select
                  aria-label={i === 0 ? undefined : `Action, rule ${i + 1}`}
                  id={`rule-${r.id}-action`}
                  label={i === 0 ? 'Action' : undefined}
                  onChange={(v) => setRuleField(i, { action: v as RuleRow['action'] })}
                  options={[
                    { label: 'Auto', value: 'auto' },
                    { label: 'Require approval', value: 'require_approval' },
                  ]}
                  value={r.action}
                />
                <Input
                  aria-label={i === 0 ? undefined : `Approvers, rule ${i + 1}`}
                  disabled={r.action !== 'require_approval'}
                  id={`rule-${r.id}-approvers`}
                  label={i === 0 ? 'Approvers' : undefined}
                  min="1"
                  onChange={(e) => setRuleField(i, { approverCount: e.target.value })}
                  placeholder="1"
                  type="number"
                  value={r.approverCount}
                />
                <Button
                  aria-label={`Remove rule ${i + 1}`}
                  onClick={() => removeRule(i)}
                  type="button"
                  variant="danger"
                >
                  ×
                </Button>
              </div>
            ))}
            <Button onClick={addRule} type="button" variant="secondary">
              Add risk class
            </Button>
          </div>
        </Card>
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          isPending={create.isPending || update.isPending}
          onCancel={onClose}
          pendingLabel={editing ? 'Saving…' : 'Creating…'}
          submitLabel={editing ? 'Save changes' : 'Create policy'}
        />
      </form>
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AutonomyPoliciesPage() {
  const { data: policies, isLoading, isError, error } = useAutonomyPolicies();
  const deletePolicy = useDeleteAutonomyPolicy();
  const [deleteTarget, setDeleteTarget] = useState<AutonomyPolicy | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AutonomyPolicy | null>(null);

  const sorted = useMemo(
    () => [...(policies ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [policies]
  );

  function startEdit(policy: AutonomyPolicy) {
    setEditing(policy);
    setOpen(true);
  }

  function startCreate() {
    setEditing(null);
    setOpen(true);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <>
            <ButtonLink href="/govern/policies/decisions" variant="secondary">
              Audit decisions
            </ButtonLink>
            <Button onClick={startCreate} variant="primary">
              New policy
            </Button>
          </>
        }
        chapter="§ Govern"
        subtitle="Which risk classes an agent may act on automatically and which need human approval — globally, per team, or per workflow template."
        title="Autonomy policies"
      />

      <QueryBoundary
        error={error}
        isError={isError}
        isLoading={isLoading}
        label="policies"
        loadingMessage="loading policies…"
      >
        <Card className="p-0" variant="inset">
          <div className="divide-y divide-ink-600">
            {sorted.map((p) => (
              <div className="flex items-start justify-between p-4" key={p.id}>
                <div className="space-y-1">
                  <p className="font-medium text-sm">{p.name}</p>
                  <p className="text-xs text-paper-400">{scopeLabel(p)}</p>
                  {p.description && <p className="text-xs text-paper-500">{p.description}</p>}
                  <p className="text-xs text-paper-500">
                    {Object.keys(p.rules).length} rule
                    {Object.keys(p.rules).length === 1 ? '' : 's'} · updated{' '}
                    {formatDate(p.updatedAt)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => startEdit(p)} size="sm" variant="secondary">
                    Edit
                  </Button>
                  <Button
                    disabled={deletePolicy.isPending}
                    onClick={() => setDeleteTarget(p)}
                    size="sm"
                    variant="danger"
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
            {sorted.length === 0 && <EmptyState title="No autonomy policies yet." />}
          </div>
        </Card>
      </QueryBoundary>

      <PolicyModal
        editing={editing}
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        open={open}
      />

      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message={`Delete the "${deleteTarget?.name}" autonomy policy? This cannot be undone.`}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await deletePolicy.mutateAsync(deleteTarget.id);
          }
        }}
        open={deleteTarget !== null}
        title="Delete autonomy policy?"
      />
    </div>
  );
}
