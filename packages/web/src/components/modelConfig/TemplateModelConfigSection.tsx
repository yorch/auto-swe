'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  MODEL_ROLES,
  type ModelRole,
  type ModelRoleConfigRow,
  type ProviderCredentialRow,
  ROLE_LABELS,
  SUGGESTED_MODEL_SPECS,
  useAdminCredentials,
  useAdminDeleteModelConfig,
  useAdminModelConfigs,
  useAdminUpsertModelConfig,
} from '@/hooks/useModelConfig';
import { MidRunWarning } from './MidRunWarning';

export function TemplateModelConfigSection({ templateId }: { templateId: string }) {
  const { data: rows, isLoading } = useAdminModelConfigs({
    scope: 'WORKFLOW_TEMPLATE',
    workflowTemplateId: templateId,
  });
  const { data: allCredsRaw } = useAdminCredentials();
  const upsert = useAdminUpsertModelConfig();
  const del = useAdminDeleteModelConfig();
  const [editing, setEditing] = useState<{
    role: ModelRole;
    existing: ModelRoleConfigRow | null;
  } | null>(null);

  const byRole = new Map((rows ?? []).map((r) => [r.role, r] as const));
  const allCreds = allCredsRaw ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Model configuration">Template overrides</CardTitle>
      </CardHeader>
      <div className="space-y-4">
        <MidRunWarning />
        <p className="text-xs text-paper-500">
          Roles without a template override inherit from the team or platform GLOBAL spec. Template
          overrides take priority over team overrides at runtime.
        </p>
        {isLoading && <p className="text-sm text-paper-400">Loading…</p>}
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-paper-500">
            <tr>
              <th className="pb-2">Role</th>
              <th className="pb-2">Override</th>
              <th className="pb-2">Pinned credential</th>
              <th className="pb-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {MODEL_ROLES.map((role) => {
              const row = byRole.get(role) ?? null;
              const cred = row?.credentialId
                ? allCreds.find((c) => c.id === row.credentialId)
                : null;
              return (
                <tr className="border-t border-ink-700" key={role}>
                  <td className="py-2">{ROLE_LABELS[role]}</td>
                  <td className="py-2 font-mono text-xs">
                    {row ? row.modelSpec : <span className="text-paper-500">inherit cascade</span>}
                  </td>
                  <td className="py-2 font-mono text-[11px] text-paper-400">
                    {cred ? `${cred.provider}/****${cred.lastFour}` : '—'}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      onClick={() => setEditing({ existing: row, role })}
                      size="sm"
                      variant="ghost"
                    >
                      {row ? 'Edit' : 'Override'}
                    </Button>
                    {row && (
                      <Button
                        onClick={() => {
                          if (!window.confirm(`Remove ${role} override for this template?`)) {
                            return;
                          }
                          del.mutate(row.id);
                        }}
                        size="sm"
                        variant="danger"
                      >
                        Reset
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && (
        <TemplateRoleEditModal
          credentials={allCreds}
          existing={editing.existing}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            await upsert.mutateAsync({
              ...body,
              scope: 'WORKFLOW_TEMPLATE',
              workflowTemplateId: templateId,
            });
            setEditing(null);
          }}
          role={editing.role}
        />
      )}
    </Card>
  );
}

function TemplateRoleEditModal({
  role,
  existing,
  credentials,
  onClose,
  onSave,
}: {
  role: ModelRole;
  existing: ModelRoleConfigRow | null;
  credentials: ProviderCredentialRow[];
  onClose: () => void;
  onSave: (body: {
    role: ModelRole;
    modelSpec: string;
    credentialId?: string | null;
    systemPrompt?: string | null;
  }) => Promise<void>;
}) {
  const [modelSpec, setModelSpec] = useState(existing?.modelSpec ?? 'anthropic/claude-opus-4-7');
  const [credentialId, setCredentialId] = useState(existing?.credentialId ?? '');
  const [systemPrompt, setSystemPrompt] = useState(existing?.systemPrompt ?? '');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await onSave({
        credentialId: credentialId || null,
        modelSpec,
        role,
        systemPrompt: systemPrompt || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const suggestions = SUGGESTED_MODEL_SPECS.flatMap((p) => p.specs);

  return (
    <Modal eyebrow="Template override" onClose={onClose} open title={`${ROLE_LABELS[role]} model`}>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="tpl-modelSpec">
            Model spec
          </label>
          <input
            className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
            id="tpl-modelSpec"
            list="tpl-model-suggestions"
            onChange={(e) => setModelSpec(e.target.value)}
            pattern="[^/\s]+/.+"
            required
            title="Must be <provider>/<model-id> with no whitespace"
            value={modelSpec}
          />
          <datalist id="tpl-model-suggestions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <Select
          className="border-ink-600 bg-ink-900"
          id="tpl-cred"
          label="Pin credential (optional)"
          onChange={(e) => setCredentialId(e.target.value)}
          value={credentialId}
        >
          <option value="">— Use scope cascade —</option>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.scope} · {c.provider}/****{c.lastFour}
            </option>
          ))}
        </Select>
        <div>
          <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="tpl-systemPrompt">
            System prompt override (optional)
          </label>
          <textarea
            className="h-32 w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
            id="tpl-systemPrompt"
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Leave blank to use the default system prompt for this role."
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
