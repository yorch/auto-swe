'use client';

import { KNOWN_RISK_CLASSES } from '@auto-swe/shared/lib/autonomyPolicy';
import { useEffect, useMemo, useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
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
import { riskClassLabel } from '@/lib/autonomyEvents';
import { errMsg } from '@/lib/errors';

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

/** One line per policy: what each risk class does ("External communication: approval from 1"). */
function ruleSummary(rules: AutonomyPolicy['rules']): string[] {
  return Object.entries(rules).map(([riskClass, rule]) =>
    rule.action === 'auto'
      ? `${riskClassLabel(riskClass)}: automatic`
      : `${riskClassLabel(riskClass)}: approval from ${rule.approverCount ?? 1}`
  );
}

/** The risk classes still free to pick: the known set minus those other rules use, plus `current`. */
function riskClassOptions(rules: RuleRow[], current: string) {
  const used = new Set(rules.map((r) => r.riskClass).filter((c) => c && c !== current));
  const options: { label: string; value: string }[] = KNOWN_RISK_CLASSES.filter(
    (c) => !used.has(c.key)
  ).map((c) => ({
    label: c.label,
    value: c.key,
  }));
  if (current && !options.some((o) => o.value === current)) {
    options.push({ label: riskClassLabel(current), value: current });
  }
  return options;
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
  const eyebrow = 'Autonomy policy';

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
        setError(`Duplicate risk class: ${riskClassLabel(r.riskClass.trim())}`);
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

  const unusedClasses = riskClassOptions(form.rules, '');

  function addRule() {
    setForm((f) => ({
      ...f,
      rules: [
        ...f.rules,
        {
          action: 'require_approval',
          approverCount: '1',
          id: crypto.randomUUID(),
          riskClass: riskClassOptions(f.rules, '')[0]?.value ?? '',
        },
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
              <div
                className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_150px_90px_40px]"
                key={r.id}
              >
                <Select
                  aria-label={`Risk class, rule ${i + 1}`}
                  id={`rule-${r.id}-risk-class`}
                  label={i === 0 ? 'Risk class' : undefined}
                  onChange={(v) => setRuleField(i, { riskClass: v })}
                  options={riskClassOptions(form.rules, r.riskClass)}
                  placeholder="Choose a risk class"
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
                  className="h-9 px-0"
                  onClick={() => removeRule(i)}
                  title="Remove rule"
                  type="button"
                  variant="ghost"
                >
                  <Icon name="close" size={14} />
                </Button>
              </div>
            ))}
            <Button
              disabled={unusedClasses.length === 0}
              onClick={addRule}
              size="sm"
              type="button"
              variant="secondary"
            >
              <Icon name="plus" size={14} />
              Add risk class
            </Button>
            <p className="text-xs text-paper-500">
              A risk class with no rule here requires approval.
            </p>
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
  const { data: policies, isLoading, isError, isFetching, refetch, error } = useAutonomyPolicies();
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
    <div className="space-y-6">
      <PageHeader
        actions={
          <>
            <ButtonLink href="/govern/policies/decisions" variant="secondary">
              Review decisions
            </ButtonLink>
            <Button onClick={startCreate} variant="primary">
              <Icon name="plus" size={14} />
              New policy
            </Button>
          </>
        }
        subtitle="Which risk classes an agent may act on automatically and which need human approval — globally, per team, or per workflow template."
        title="Autonomy policies"
      />

      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={false}
        label="policies"
        onRetry={() => void refetch()}
      >
        {isLoading ? (
          <Card>
            <SkeletonRows rows={3} />
          </Card>
        ) : sorted.length === 0 ? (
          <EmptyState
            action={
              <Button onClick={startCreate} size="sm" variant="primary">
                <Icon name="plus" size={14} />
                New policy
              </Button>
            }
            bordered
            hint="Without a policy every risk class needs human approval. A policy lets low-risk actions run automatically."
            icon="gavel"
            title="No autonomy policies yet"
          />
        ) : (
          <ul className="space-y-3">
            {sorted.map((p) => {
              const rules = Object.entries(p.rules);
              return (
                <li key={p.id}>
                  <Card className="p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-base font-semibold text-paper-50">{p.name}</h2>
                          <Badge
                            tone={p.template ? 'violet' : p.team ? 'dust' : 'neutral'}
                            variant="outline"
                          >
                            {scopeLabel(p)}
                          </Badge>
                        </div>
                        {p.description && (
                          <p className="text-[13px] text-paper-400">{p.description}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button onClick={() => startEdit(p)} size="sm" variant="secondary">
                          Edit
                        </Button>
                        <ActionMenu
                          items={[
                            {
                              disabled: deletePolicy.isPending,
                              icon: 'trash',
                              id: 'delete',
                              label: 'Delete policy',
                              onAction: () => setDeleteTarget(p),
                              tone: 'danger',
                            },
                          ]}
                          label={`More actions for ${p.name}`}
                        />
                      </div>
                    </div>
                    {rules.length > 0 ? (
                      <ul aria-label="Rules" className="mt-3 flex flex-wrap gap-2">
                        {rules.map(([riskClass, rule]) => (
                          <li
                            className="inline-flex items-center gap-2 rounded-md border border-ink-500 bg-ink-900/50 py-1 pr-1.5 pl-2.5 text-xs"
                            key={riskClass}
                            title={ruleSummary({ [riskClass]: rule })[0]}
                          >
                            <span className="text-paper-200">{riskClassLabel(riskClass)}</span>
                            {rule.action === 'auto' ? (
                              <Badge tone="moss">Automatic</Badge>
                            ) : (
                              <Badge tone="amber">
                                {(rule.approverCount ?? 1) === 1
                                  ? '1 approver'
                                  : `${rule.approverCount} approvers`}
                              </Badge>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-3 text-xs text-paper-500">
                        No rules — every risk class requires approval.
                      </p>
                    )}
                    <p className="mt-3 text-xs text-paper-500">
                      Updated <RelativeTime value={p.updatedAt} />
                    </p>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
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
