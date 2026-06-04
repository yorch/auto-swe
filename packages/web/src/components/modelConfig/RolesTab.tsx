'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  type ConfigScope,
  MODEL_ROLES,
  type ModelRole,
  type ModelRoleConfigRow,
  type ProviderCredentialRow,
  SUGGESTED_MODEL_SPECS,
  useAdminCredentials,
  useAdminDeleteModelConfig,
  useAdminModelConfigs,
  useAdminUpsertModelConfig,
  useSeedDefaults,
} from '@/hooks/useModelConfig';

const ROLE_LABELS: Record<ModelRole, string> = {
  COMMIT_TO_MEMORY: 'Memory summarizer',
  IMPLEMENTER: 'Implementer',
  PLANNER: 'Planner',
  REVIEWER: 'Reviewer',
  SECURITY_REVIEW: 'Security review',
  VALIDATE_CONTEXT: 'Context validator',
};

/// Admin Roles tab — shows every ModelRoleConfig row across all scopes, lets
/// admins edit them in a single modal. Team/template rows are flagged with
/// their scope-key for context.
export function RolesTab() {
  const { data: rows, isLoading } = useAdminModelConfigs();
  const { data: credentials } = useAdminCredentials();
  const [editing, setEditing] = useState<ModelRoleConfigRow | null>(null);
  const [creatingFor, setCreatingFor] = useState<ModelRole | null>(null);

  const upsert = useAdminUpsertModelConfig();
  const del = useAdminDeleteModelConfig();
  const seedDefaults = useSeedDefaults();

  // Empty-state detection. The worker refuses to start without GLOBAL rows
  // for every role + an EmbeddingConfig, so a fresh install lands here.
  const globalRoles = (rows ?? []).filter((r) => r.scope === 'GLOBAL').map((r) => r.role);
  const missingGlobalRoles = MODEL_ROLES.filter((r) => !globalRoles.includes(r));
  const showBootstrapBanner = !isLoading && missingGlobalRoles.length > 0;

  const byRole: Record<ModelRole, ModelRoleConfigRow[]> = {
    COMMIT_TO_MEMORY: [],
    IMPLEMENTER: [],
    PLANNER: [],
    REVIEWER: [],
    SECURITY_REVIEW: [],
    VALIDATE_CONTEXT: [],
  };
  for (const row of rows ?? []) {
    byRole[row.role].push(row);
  }

  return (
    <div className="space-y-6">
      {isLoading && <p className="text-sm text-paper-400">Loading…</p>}
      {showBootstrapBanner && (
        <div className="rounded-sm border border-ember-400/40 bg-ember-400/5 px-4 py-3 text-xs text-ember-200">
          <div className="mb-2">
            <strong className="font-semibold text-ember-100">Bootstrap needed.</strong>{' '}
            {missingGlobalRoles.length} of 6 roles have no GLOBAL configuration. The worker will
            refuse to start until every role + at least one matching credential exists.
          </div>
          <Button
            disabled={seedDefaults.isPending}
            onClick={() => seedDefaults.mutate()}
            size="sm"
            variant="primary"
          >
            {seedDefaults.isPending ? 'Seeding…' : 'Seed Anthropic defaults'}
          </Button>
          <span className="ml-2 text-[11px] text-paper-500">
            Creates GLOBAL rows pointing at <code>anthropic/claude-opus-4-7</code> /{' '}
            <code>claude-sonnet-4-6</code>. Add an Anthropic credential under the Credentials tab.
          </span>
        </div>
      )}
      {MODEL_ROLES.map((role) => (
        <Card key={role}>
          <CardHeader>
            <CardTitle eyebrow={role.replace(/_/g, ' ').toLowerCase()}>
              {ROLE_LABELS[role]}
            </CardTitle>
            <Button onClick={() => setCreatingFor(role)} size="sm">
              + Override
            </Button>
          </CardHeader>
          <div className="space-y-3">
            {byRole[role].length === 0 && (
              <p className="text-xs text-paper-500">
                No GLOBAL row yet — the env-fallback default applies until one is created.
              </p>
            )}
            {byRole[role].map((row) => (
              <RoleRow
                credentials={credentials ?? []}
                key={row.id}
                onDelete={() => {
                  if (row.scope === 'GLOBAL') {
                    return;
                  }
                  if (!window.confirm(`Delete ${row.scope} override for ${role}?`)) {
                    return;
                  }
                  del.mutate(row.id);
                }}
                onEdit={() => setEditing(row)}
                row={row}
              />
            ))}
          </div>
        </Card>
      ))}
      {(editing || creatingFor) && (
        <EditRoleModal
          credentials={credentials ?? []}
          existing={editing}
          newRoleDefault={creatingFor}
          onClose={() => {
            setEditing(null);
            setCreatingFor(null);
          }}
          onSave={async (body) => {
            await upsert.mutateAsync(body);
            setEditing(null);
            setCreatingFor(null);
          }}
        />
      )}
    </div>
  );
}

function RoleRow({
  row,
  credentials,
  onEdit,
  onDelete,
}: {
  row: ModelRoleConfigRow;
  credentials: ProviderCredentialRow[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const cred = row.credentialId ? credentials.find((c) => c.id === row.credentialId) : null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-sm border border-ink-600 bg-ink-800/40 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3 text-xs">
          <ScopeBadge scope={row.scope} />
          <code className="font-mono text-paper-100">{row.modelSpec}</code>
        </div>
        <div className="mt-1 text-[11px] text-paper-500">
          {row.scope === 'TEAM' && row.teamId && <>Team {row.teamId.slice(0, 8)}… </>}
          {row.scope === 'WORKFLOW_TEMPLATE' && row.workflowTemplateId && (
            <>Template {row.workflowTemplateId.slice(0, 8)}… </>
          )}
          {cred && (
            <>
              · pinned credential{' '}
              <code className="font-mono">
                {cred.provider}/****{cred.lastFour}
              </code>
            </>
          )}
        </div>
        {row.systemPrompt && (
          <div className="mt-1 text-[10px] text-paper-500 truncate font-mono">
            prompt: {row.systemPrompt.slice(0, 60)}
            {row.systemPrompt.length > 60 ? '…' : ''}
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <Button onClick={onEdit} size="sm" variant="ghost">
          Edit
        </Button>
        <Button
          disabled={row.scope === 'GLOBAL'}
          onClick={onDelete}
          size="sm"
          title={row.scope === 'GLOBAL' ? 'GLOBAL rows cannot be deleted — only updated' : ''}
          variant="danger"
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function ScopeBadge({ scope }: { scope: ConfigScope }) {
  const color =
    scope === 'GLOBAL'
      ? 'bg-ember-400/15 text-ember-300 border-ember-400/30'
      : scope === 'TEAM'
        ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
        : 'bg-purple-500/15 text-purple-300 border-purple-500/30';
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${color}`}>
      {scope.replace('_', ' ')}
    </span>
  );
}

function EditRoleModal({
  existing,
  newRoleDefault,
  credentials,
  onClose,
  onSave,
}: {
  existing: ModelRoleConfigRow | null;
  newRoleDefault: ModelRole | null;
  credentials: ProviderCredentialRow[];
  onClose: () => void;
  onSave: (body: {
    role: ModelRole;
    scope: ConfigScope;
    teamId?: string;
    workflowTemplateId?: string;
    modelSpec: string;
    credentialId?: string | null;
    systemPrompt?: string | null;
  }) => Promise<void>;
}) {
  const [role, setRole] = useState<ModelRole>(existing?.role ?? newRoleDefault ?? 'IMPLEMENTER');
  const [scope, setScope] = useState<ConfigScope>(existing?.scope ?? 'GLOBAL');
  const [teamId, setTeamId] = useState(existing?.teamId ?? '');
  const [workflowTemplateId, setWorkflowTemplateId] = useState(existing?.workflowTemplateId ?? '');
  const [modelSpec, setModelSpec] = useState(existing?.modelSpec ?? 'anthropic/claude-opus-4-7');
  const [credentialId, setCredentialId] = useState(existing?.credentialId ?? '');
  const [systemPrompt, setSystemPrompt] = useState<string>(existing?.systemPrompt ?? '');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await onSave({
        credentialId: credentialId || null,
        modelSpec,
        role,
        scope,
        systemPrompt: systemPrompt.trim() || null,
        ...(scope === 'TEAM' && { teamId }),
        ...(scope === 'WORKFLOW_TEMPLATE' && { workflowTemplateId }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const suggestions = SUGGESTED_MODEL_SPECS.flatMap((p) => p.specs);

  return (
    <Modal
      eyebrow="Model role"
      onClose={onClose}
      open
      title={existing ? `Edit ${role}` : `New ${role} override`}
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        {!existing && (
          <Select
            className="border-ink-600 bg-ink-900"
            id="role"
            label="Role"
            onChange={(e) => setRole(e.target.value as ModelRole)}
            value={role}
          >
            {MODEL_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        )}
        {!existing && (
          <Select
            className="border-ink-600 bg-ink-900"
            id="scope"
            label="Scope"
            onChange={(e) => setScope(e.target.value as ConfigScope)}
            value={scope}
          >
            <option value="GLOBAL">Global (system-wide default)</option>
            <option value="TEAM">Team</option>
            <option value="WORKFLOW_TEMPLATE">Workflow template</option>
          </Select>
        )}
        {scope === 'TEAM' && (
          <div>
            <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="teamId">
              Team ID
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
              disabled={!!existing}
              id="teamId"
              onChange={(e) => setTeamId(e.target.value)}
              placeholder="00000000-0000-4000-8000-000000000000"
              value={teamId}
            />
          </div>
        )}
        {scope === 'WORKFLOW_TEMPLATE' && (
          <div>
            <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="tplId">
              Workflow template ID
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
              disabled={!!existing}
              id="tplId"
              onChange={(e) => setWorkflowTemplateId(e.target.value)}
              placeholder="00000000-0000-4000-8000-000000000000"
              value={workflowTemplateId}
            />
          </div>
        )}
        <div>
          <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="modelSpec">
            Model spec
          </label>
          <input
            className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
            id="modelSpec"
            list="model-suggestions"
            onChange={(e) => setModelSpec(e.target.value)}
            pattern="[^/\s]+/.+"
            placeholder="anthropic/claude-opus-4-7"
            required
            title="Must be <provider>/<model-id> with no whitespace"
            value={modelSpec}
          />
          <datalist id="model-suggestions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <p className="mt-1 text-[11px] text-paper-500">
            Format: <code>{'<provider>/<model-id>'}</code>. Pick a suggestion or enter any string.
          </p>
        </div>
        <Select
          className="border-ink-600 bg-ink-900"
          id="credId"
          label="Pinned credential (optional)"
          onChange={(e) => setCredentialId(e.target.value)}
          value={credentialId}
        >
          <option value="">— Use scope cascade —</option>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.scope} · {c.provider}/****{c.lastFour}
              {c.teamId && ` (team ${c.teamId.slice(0, 6)}…)`}
            </option>
          ))}
        </Select>
        <div>
          <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="systemPrompt">
            System prompt override
            <span className="ml-1 text-[10px] normal-case text-paper-500">
              (optional — leave empty to use the global default)
            </span>
          </label>
          <textarea
            className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs resize-y"
            id="systemPrompt"
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Leave empty to use the built-in default prompt for this role."
            rows={8}
            value={systemPrompt}
          />
        </div>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
