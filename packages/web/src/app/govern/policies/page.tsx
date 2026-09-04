'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
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

  const title = editing ? 'Edit Autonomy Policy' : 'New Autonomy Policy';
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
    <Modal eyebrow={eyebrow} onClose={onClose} open={open} title={title}>
      <form className="space-y-4 min-w-[560px] max-w-2xl" onSubmit={handleSubmit}>
        <FieldWrapper label="Name">
          <Input
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Strict external comms"
            required
            value={form.name}
          />
        </FieldWrapper>
        <FieldWrapper label="Description">
          <Input
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="What this policy controls"
            value={form.description}
          />
        </FieldWrapper>
        <FieldWrapper label="Scope">
          <Select
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                scope: e.target.value as Scope,
                teamId: '',
                templateId: '',
              }))
            }
            value={form.scope}
          >
            <option value="global">Global default</option>
            <option value="team">Team default</option>
            <option value="template">Template override</option>
          </Select>
        </FieldWrapper>
        {form.scope === 'team' && (
          <FieldWrapper label="Team">
            <Select
              onChange={(e) => setForm((f) => ({ ...f, teamId: e.target.value }))}
              value={form.teamId}
            >
              <option value="">Select a team</option>
              {(teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FieldWrapper>
        )}
        {form.scope === 'template' && (
          <FieldWrapper label="Template">
            <Select
              onChange={(e) => setForm((f) => ({ ...f, templateId: e.target.value }))}
              value={form.templateId}
            >
              <option value="">Select a template</option>
              {(templates ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FieldWrapper>
        )}
        <Card variant="inset">
          <CardHeader>
            <CardTitle>Risk-class rules</CardTitle>
          </CardHeader>
          <div className="space-y-3">
            {form.rules.map((r, i) => (
              <div className="grid grid-cols-[1fr_120px_80px_40px] gap-2 items-end" key={r.id}>
                <FieldWrapper label={i === 0 ? 'Risk class' : undefined}>
                  <Input
                    onChange={(e) => setRuleField(i, { riskClass: e.target.value })}
                    placeholder="e.g. external_communication"
                    value={r.riskClass}
                  />
                </FieldWrapper>
                <FieldWrapper label={i === 0 ? 'Action' : undefined}>
                  <Select
                    onChange={(e) =>
                      setRuleField(i, { action: e.target.value as RuleRow['action'] })
                    }
                    value={r.action}
                  >
                    <option value="auto">Auto</option>
                    <option value="require_approval">Require approval</option>
                  </Select>
                </FieldWrapper>
                <FieldWrapper label={i === 0 ? 'Approvers' : undefined}>
                  <Input
                    disabled={r.action !== 'require_approval'}
                    min="1"
                    onChange={(e) => setRuleField(i, { approverCount: e.target.value })}
                    placeholder="1"
                    type="number"
                    value={r.approverCount}
                  />
                </FieldWrapper>
                <Button onClick={() => removeRule(i)} type="button" variant="ghost">
                  ×
                </Button>
              </div>
            ))}
            <Button onClick={addRule} type="button" variant="secondary">
              Add risk class
            </Button>
          </div>
        </Card>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={create.isPending || update.isPending} type="submit" variant="primary">
            {create.isPending || update.isPending
              ? 'Saving…'
              : editing
                ? 'Save Policy'
                : 'Create Policy'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AutonomyPoliciesPage() {
  const router = useRouter();
  const { data: policies, isLoading } = useAutonomyPolicies();
  const deletePolicy = useDeleteAutonomyPolicy();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AutonomyPolicy | null>(null);

  const sorted = useMemo(
    () => [...(policies ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [policies]
  );

  if (isLoading) {
    return <LoadingState message="loading policies…" />;
  }

  function startEdit(policy: AutonomyPolicy) {
    setEditing(policy);
    setOpen(true);
  }

  function startCreate() {
    setEditing(null);
    setOpen(true);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <div className="flex gap-2">
            <Button onClick={() => router.push('/govern/policies/decisions')} variant="secondary">
              Audit decisions
            </Button>
            <Button onClick={startCreate} variant="primary">
              New Policy
            </Button>
          </div>
        }
        chapter="§ Govern"
        title="Autonomy Policies"
      />

      <Card variant="inset">
        <div className="divide-y divide-ink-100/10">
          {sorted.map((p) => (
            <div className="flex items-start justify-between p-4" key={p.id}>
              <div className="space-y-1">
                <p className="font-medium text-sm">{p.name}</p>
                <p className="text-xs text-paper-400">{scopeLabel(p)}</p>
                {p.description && <p className="text-xs text-paper-500">{p.description}</p>}
                <p className="text-xs text-paper-500">
                  {Object.keys(p.rules).length} rule
                  {Object.keys(p.rules).length === 1 ? '' : 's'} · updated {formatDate(p.updatedAt)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => startEdit(p)} variant="secondary">
                  Edit
                </Button>
                <Button
                  disabled={deletePolicy.isPending}
                  onClick={() => deletePolicy.mutate(p.id)}
                  variant="danger"
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
          {sorted.length === 0 && (
            <p className="text-center text-paper-400 py-12">No autonomy policies yet.</p>
          )}
        </div>
      </Card>

      <PolicyModal
        editing={editing}
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        open={open}
      />
    </div>
  );
}
