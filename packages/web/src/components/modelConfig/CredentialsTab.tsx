'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import {
  type ProviderCredentialRow,
  useAdminCreateCredential,
  useAdminCredentials,
  useAdminDeleteCredential,
  useAdminTestCredential,
  useAdminUpdateCredential,
} from '@/hooks/useModelConfig';

type ProbeResult = { ok: boolean; status?: number; error?: string };

export function CredentialsTab() {
  const { data: credentials, isLoading } = useAdminCredentials();
  const [editing, setEditing] = useState<ProviderCredentialRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({});
  // Per-row pending flag — `useMutation` returns a single `isPending` shared
  // across all rows, so we track our own per-id state.
  const [probePending, setProbePending] = useState<Record<string, boolean>>({});

  const create = useAdminCreateCredential();
  const update = useAdminUpdateCredential();
  const del = useAdminDeleteCredential();
  const test = useAdminTestCredential();

  const handleTest = async (id: string) => {
    setProbePending((s) => ({ ...s, [id]: true }));
    try {
      const res = await test.mutateAsync(id);
      setProbeResults((s) => ({ ...s, [id]: res.data }));
    } catch (err) {
      setProbeResults((s) => ({
        ...s,
        [id]: { error: err instanceof Error ? err.message : 'request failed', ok: false },
      }));
    } finally {
      setProbePending((s) => ({ ...s, [id]: false }));
    }
  };

  /// Drop stale probe results when the user is about to edit a credential —
  /// otherwise the prior OK/error stays visible after the apiKey changes.
  const clearProbeForRow = (id: string) => {
    setProbeResults((s) => {
      const { [id]: _drop, ...rest } = s;
      return rest;
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Provider credentials">API keys</CardTitle>
        <Button onClick={() => setCreating(true)} size="sm">
          + New credential
        </Button>
      </CardHeader>
      {isLoading && <p className="text-sm text-paper-400">Loading…</p>}
      <table className="w-full text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wide text-paper-500">
          <tr>
            <th className="pb-2">Provider</th>
            <th className="pb-2">Scope</th>
            <th className="pb-2">API base</th>
            <th className="pb-2">Key</th>
            <th className="pb-2">Test</th>
            <th className="pb-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {(credentials ?? []).map((c) => (
            <tr className="border-t border-ink-700" key={c.id}>
              <td className="py-2 font-mono text-xs">{c.provider}</td>
              <td className="py-2 text-xs">
                {c.scope}
                {c.teamId && ` (${c.teamId.slice(0, 8)}…)`}
              </td>
              <td className="py-2 font-mono text-[11px] text-paper-400">{c.apiBase ?? '—'}</td>
              <td className="py-2 font-mono text-xs">{c.maskedKey}</td>
              <td className="py-2 text-xs">
                <Button
                  disabled={!!probePending[c.id]}
                  onClick={() => handleTest(c.id)}
                  size="sm"
                  variant="ghost"
                >
                  {probePending[c.id] ? '…' : 'Test'}
                </Button>
                {probeResults[c.id] && (
                  <span
                    className={`ml-2 text-[10px] ${probeResults[c.id].ok ? 'text-emerald-400' : 'text-brick-400'}`}
                  >
                    {probeResults[c.id].ok
                      ? `OK (${probeResults[c.id].status})`
                      : (probeResults[c.id].error ?? `HTTP ${probeResults[c.id].status}`)}
                  </span>
                )}
              </td>
              <td className="py-2 text-right">
                <Button
                  onClick={() => {
                    clearProbeForRow(c.id);
                    setEditing(c);
                  }}
                  size="sm"
                  variant="ghost"
                >
                  Edit
                </Button>
                <Button
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Delete ${c.provider} credential? Roles pinning it will fall back to the cascade.`
                      )
                    ) {
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
      {(creating || editing) && (
        <CredentialModal
          existing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={async (body) => {
            if (editing) {
              await update.mutateAsync({ id: editing.id, ...body });
            } else {
              await create.mutateAsync(body as Parameters<typeof create.mutateAsync>[0]);
            }
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </Card>
  );
}

function CredentialModal({
  existing,
  onClose,
  onSave,
}: {
  existing: ProviderCredentialRow | null;
  onClose: () => void;
  onSave: (body: {
    provider?: string;
    scope?: 'GLOBAL' | 'TEAM';
    teamId?: string;
    apiBase?: string;
    apiKey?: string;
  }) => Promise<void>;
}) {
  const [provider, setProvider] = useState(existing?.provider ?? '');
  const [scope, setScope] = useState<'GLOBAL' | 'TEAM'>(
    existing?.scope === 'TEAM' ? 'TEAM' : 'GLOBAL'
  );
  const [teamId, setTeamId] = useState(existing?.teamId ?? '');
  const [apiBase, setApiBase] = useState(existing?.apiBase ?? '');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (existing) {
        // Update: only apiBase + apiKey are editable.
        await onSave({
          ...(apiBase !== (existing.apiBase ?? '') && { apiBase: apiBase || undefined }),
          ...(apiKey && { apiKey }),
        });
      } else {
        await onSave({
          apiKey,
          provider,
          scope,
          ...(scope === 'TEAM' && { teamId }),
          ...(apiBase && { apiBase }),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <Modal
      eyebrow="Credential"
      onClose={onClose}
      open
      title={existing ? `Edit ${existing.provider}` : 'New provider credential'}
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        {!existing && (
          <>
            <div>
              <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="provider">
                Provider name
              </label>
              <input
                className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
                id="provider"
                onChange={(e) => setProvider(e.target.value)}
                placeholder="anthropic / openai / google / opencodego / ..."
                value={provider}
              />
              <p className="mt-1 text-[11px] text-paper-500">
                Lowercase kebab-case. Built-in: anthropic, openai, google. Anything else is treated
                as OpenAI-compatible and requires an apiBase URL.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="scope">
                Scope
              </label>
              <select
                className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 text-sm"
                id="scope"
                onChange={(e) => setScope(e.target.value as 'GLOBAL' | 'TEAM')}
                value={scope}
              >
                <option value="GLOBAL">Global (used by every team unless overridden)</option>
                <option value="TEAM">Team</option>
              </select>
            </div>
            {scope === 'TEAM' && (
              <div>
                <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="teamId">
                  Team ID
                </label>
                <input
                  className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
                  id="teamId"
                  onChange={(e) => setTeamId(e.target.value)}
                  value={teamId}
                />
              </div>
            )}
          </>
        )}
        <div>
          <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="apiBase">
            API base URL (optional)
          </label>
          <input
            className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
            id="apiBase"
            onChange={(e) => setApiBase(e.target.value)}
            placeholder="https://opencode.ai/zen/go/v1"
            value={apiBase}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="apiKey">
            API key {existing && '(leave blank to keep existing)'}
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
            Stored encrypted at rest. You won't see this value again — copy it from your password
            manager before saving.
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
