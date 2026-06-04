'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  MODEL_ROLES,
  ROLE_LABELS,
  type ModelRole,
  type ModelRoleConfigRow,
  type ProviderCredentialRow,
  SUGGESTED_MODEL_SPECS,
  useTeamAccessibleCredentials,
  useTeamCreateCredential,
  useTeamCredentials,
  useTeamDeleteCredential,
  useTeamDeleteModelConfig,
  useTeamModelConfig,
  useTeamUpdateCredential,
  useTeamUpsertModelConfig,
} from '@/hooks/useModelConfig';
import { MidRunWarning } from './MidRunWarning';


/// Team owner's view of model config. Only TEAM-scope rows are editable here;
/// GLOBAL/WORKFLOW_TEMPLATE rows are hidden (admins manage them elsewhere).
/// Team credentials may reference GLOBAL credentials owned by admins too.
export function TeamModelConfigSection({ teamId }: { teamId: string }) {
  const { data: rows, isLoading } = useTeamModelConfig(teamId);
  // Pin-credential picker pulls from the team-scoped accessible-credentials
  // endpoint (TEAM + GLOBAL) — using the admin-only credentials list would
  // 403 for non-platform-admin team owners.
  const { data: accessibleCredsRaw } = useTeamAccessibleCredentials(teamId);
  const upsert = useTeamUpsertModelConfig(teamId);
  const del = useTeamDeleteModelConfig(teamId);
  const [editing, setEditing] = useState<{
    role: ModelRole;
    existing: ModelRoleConfigRow | null;
  } | null>(null);

  const byRole = new Map((rows ?? []).map((r) => [r.role, r] as const));
  const accessibleCreds = accessibleCredsRaw ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Model configuration">Team overrides</CardTitle>
      </CardHeader>
      <div className="space-y-4">
        <MidRunWarning />
        <p className="text-xs text-paper-500">
          Roles without a team override inherit the platform-wide GLOBAL spec. Removing an override
          falls back to GLOBAL on the next activity call.
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
                ? accessibleCreds.find((c) => c.id === row.credentialId)
                : null;
              return (
                <tr className="border-t border-ink-700" key={role}>
                  <td className="py-2">{ROLE_LABELS[role]}</td>
                  <td className="py-2 font-mono text-xs">
                    {row ? row.modelSpec : <span className="text-paper-500">inherit GLOBAL</span>}
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
                          if (!window.confirm(`Remove ${role} override?`)) {
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
        <TeamCredentialsSubsection teamId={teamId} />
      </div>
      {editing && (
        <TeamRoleEditModal
          credentials={accessibleCreds}
          existing={editing.existing}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            await upsert.mutateAsync(body);
            setEditing(null);
          }}
          role={editing.role}
        />
      )}
    </Card>
  );
}

function TeamCredentialsSubsection({ teamId }: { teamId: string }) {
  const { data: creds } = useTeamCredentials(teamId);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProviderCredentialRow | null>(null);
  const create = useTeamCreateCredential(teamId);
  const update = useTeamUpdateCredential(teamId);
  const del = useTeamDeleteCredential(teamId);

  return (
    <div className="rounded-sm border border-ink-700 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold">Team-scoped credentials</h4>
        <Button onClick={() => setCreating(true)} size="sm">
          + Credential
        </Button>
      </div>
      <p className="mb-3 text-xs text-paper-500">
        These override GLOBAL credentials for matching providers, but only for runs owned by this
        team.
      </p>
      {(creds ?? []).length === 0 ? (
        <p className="text-xs text-paper-500">No team credentials.</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {creds?.map((c) => (
              <tr className="border-t border-ink-700" key={c.id}>
                <td className="py-2 font-mono">{c.provider}</td>
                <td className="py-2 font-mono text-[11px] text-paper-400">{c.apiBase ?? '—'}</td>
                <td className="py-2 font-mono">{c.maskedKey}</td>
                <td className="py-2 text-right">
                  <Button onClick={() => setEditing(c)} size="sm" variant="ghost">
                    Edit
                  </Button>
                  <Button
                    onClick={() => {
                      if (!window.confirm(`Delete ${c.provider} team credential?`)) {
                        return;
                      }
                      del.mutate(c.id);
                    }}
                    size="sm"
                    variant="danger"
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(creating || editing) && (
        <TeamCredentialModal
          existing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={async (body) => {
            if (editing) {
              await update.mutateAsync({ credId: editing.id, ...body });
            } else {
              await create.mutateAsync(body as Parameters<typeof create.mutateAsync>[0]);
            }
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function TeamRoleEditModal({
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
  }) => Promise<void>;
}) {
  const [modelSpec, setModelSpec] = useState(existing?.modelSpec ?? 'anthropic/claude-opus-4-7');
  const [credentialId, setCredentialId] = useState(existing?.credentialId ?? '');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await onSave({ credentialId: credentialId || null, modelSpec, role });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const suggestions = SUGGESTED_MODEL_SPECS.flatMap((p) => p.specs);

  return (
    <Modal eyebrow="Team override" onClose={onClose} open title={`${ROLE_LABELS[role]} model`}>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="modelSpec">
            Model spec
          </label>
          <input
            className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
            id="modelSpec"
            list="team-model-suggestions"
            onChange={(e) => setModelSpec(e.target.value)}
            pattern="[^/\s]+/.+"
            required
            title="Must be <provider>/<model-id> with no whitespace"
            value={modelSpec}
          />
          <datalist id="team-model-suggestions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <Select
          className="border-ink-600 bg-ink-900"
          id="cred"
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

function TeamCredentialModal({
  existing,
  onClose,
  onSave,
}: {
  existing: ProviderCredentialRow | null;
  onClose: () => void;
  // null clears the apiBase column on the server; undefined keeps it.
  onSave: (body: { provider?: string; apiBase?: string | null; apiKey?: string }) => Promise<void>;
}) {
  const [provider, setProvider] = useState(existing?.provider ?? '');
  const [apiBase, setApiBase] = useState(existing?.apiBase ?? '');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (existing) {
        await onSave({
          // Send null explicitly to clear; undefined would be JSON-stripped
          // and the stale URL would persist.
          ...(apiBase !== (existing.apiBase ?? '') && { apiBase: apiBase || null }),
          ...(apiKey && { apiKey }),
        });
      } else {
        await onSave({
          apiKey,
          provider,
          ...(apiBase && { apiBase }),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <Modal
      eyebrow="Team credential"
      onClose={onClose}
      open
      title={existing ? `Edit ${existing.provider}` : 'New team credential'}
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        {!existing && (
          <div>
            <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="provider">
              Provider
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
              id="provider"
              onChange={(e) => setProvider(e.target.value)}
              placeholder="anthropic / openai / google / ..."
              value={provider}
            />
          </div>
        )}
        <div>
          <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="apiBase">
            API base URL (optional)
          </label>
          <input
            className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
            id="apiBase"
            onChange={(e) => setApiBase(e.target.value)}
            value={apiBase}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="apiKey">
            API key {existing && '(leave blank to keep)'}
          </label>
          <input
            className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
            id="apiKey"
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={existing ? `····${existing.lastFour}` : 'sk-...'}
            type="password"
            value={apiKey}
          />
          <p className="mt-1 text-[11px] text-amber-300">
            Stored encrypted. You won't see this value again after saving.
          </p>
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
