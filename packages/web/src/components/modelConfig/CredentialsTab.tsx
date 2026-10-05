'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import {
  type ProviderCredentialRow,
  useAdminCreateCredential,
  useAdminCredentials,
  useAdminDeleteCredential,
  useAdminTestCredential,
  useAdminUpdateCredential,
} from '@/hooks/useModelConfig';
import { useTeams } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';

type ProbeResult = { ok: boolean; status?: number; error?: string };

const BUILTIN_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
type BuiltinProvider = (typeof BUILTIN_PROVIDERS)[number];

const BUILTIN_PROVIDER_HINTS: Record<BuiltinProvider, string> = {
  anthropic: 'Built-in — no API base needed. Key format: sk-ant-…',
  google: 'Built-in — no API base needed. Key is the Gemini API key from Google AI Studio.',
  openai: 'Built-in — no API base needed. Key format: sk-…',
};

/** Only a GLOBAL credential is a platform-wide one; a scoped credential falls back to it. */
export function isLastPlatformCredential(
  target: ProviderCredentialRow,
  all: ProviderCredentialRow[]
): boolean {
  return (
    target.scope === 'GLOBAL' &&
    !all.some((c) => c.id !== target.id && c.provider === target.provider && c.scope === 'GLOBAL')
  );
}

function deleteMessage(target: ProviderCredentialRow, all: ProviderCredentialRow[]) {
  const usedBy = target.usage?.agents ?? [];
  const embedding = target.usage?.embedding ?? false;
  const isLast = isLastPlatformCredential(target, all);
  return (
    <div className="space-y-2">
      <p>
        Delete the {target.provider} credential ending {target.lastFour}? This cannot be undone.
      </p>
      {(usedBy.length > 0 || embedding) && (
        <p>
          Used by{' '}
          {[
            ...(usedBy.length > 0
              ? [`${usedBy.length === 1 ? 'agent' : 'agents'} ${usedBy.join(', ')}`]
              : []),
            ...(embedding ? ['semantic memory embeddings'] : []),
          ].join(' and ')}
          . They will use another {target.provider} credential if one applies, otherwise they will
          fail.
        </p>
      )}
      {isLast && (
        <p className="font-medium text-brick-400">
          This is the last platform-wide {target.provider} credential. Every agent using{' '}
          {target.provider} models will fail.
        </p>
      )}
    </div>
  );
}

export function CredentialsTab() {
  const { data: credentials, error: loadError, isError, isLoading } = useAdminCredentials();
  const [editing, setEditing] = useState<ProviderCredentialRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ProviderCredentialRow | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({});
  // Per-row pending flag — `useMutation` returns a single `isPending` shared
  // across all rows, so we track our own per-id state.
  const [probePending, setProbePending] = useState<Record<string, boolean>>({});

  const create = useAdminCreateCredential();
  const update = useAdminUpdateCredential();
  const del = useAdminDeleteCredential();
  const test = useAdminTestCredential();
  const { data: teams } = useTeams();
  const teamName = (id: string) => teams?.find((t) => t.id === id)?.name ?? `${id.slice(0, 8)}…`;

  const handleTest = async (id: string) => {
    setProbePending((s) => ({ ...s, [id]: true }));
    try {
      const res = await test.mutateAsync(id);
      setProbeResults((s) => ({ ...s, [id]: res.data }));
    } catch (err) {
      setProbeResults((s) => ({
        ...s,
        [id]: { error: errMsg(err, 'request failed'), ok: false },
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
          New credential
        </Button>
      </CardHeader>
      <QueryBoundary error={loadError} isError={isError} isLoading={isLoading} label="credentials">
        <Table>
          <THead>
            <Th variant="compact">Provider</Th>
            <Th variant="compact">Scope</Th>
            <Th variant="compact">API base</Th>
            <Th variant="compact">Key</Th>
            <Th variant="compact">Test</Th>
            <Th align="right" variant="compact">
              Actions
            </Th>
          </THead>
          <tbody>
            {(credentials ?? []).map((c) => (
              <TRow key={c.id}>
                <Td className="py-2 font-mono text-xs">{c.provider}</Td>
                <Td className="py-2 text-xs">
                  {c.scope}
                  {c.teamId && ` (${teamName(c.teamId)})`}
                </Td>
                <Td className="py-2 font-mono text-[11px] text-paper-400">{c.apiBase ?? '—'}</Td>
                <Td className="py-2 font-mono text-xs">{c.maskedKey}</Td>
                <Td className="py-2 text-xs">
                  <Button
                    disabled={!!probePending[c.id]}
                    onClick={() => handleTest(c.id)}
                    size="sm"
                    variant="ghost"
                  >
                    {probePending[c.id] ? '…' : 'Test'}
                  </Button>
                  {probeResults[c.id] && (
                    <Badge
                      className="ml-2"
                      tone={probeResults[c.id].ok ? 'moss' : 'brick'}
                      variant="text"
                    >
                      {probeResults[c.id].ok
                        ? `OK (${probeResults[c.id].status})`
                        : (probeResults[c.id].error ?? `HTTP ${probeResults[c.id].status}`)}
                    </Badge>
                  )}
                </Td>
                <Td className="py-2 text-right">
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
                  <Button onClick={() => setDeleting(c)} size="sm" variant="danger">
                    Delete
                  </Button>
                </Td>
              </TRow>
            ))}
            {(credentials ?? []).length === 0 && (
              <TableStatusRow colSpan={6}>
                <EmptyState
                  hint="Add one before any agent can call a model."
                  title="No provider credentials yet"
                />
              </TableStatusRow>
            )}
          </tbody>
        </Table>
      </QueryBoundary>
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

      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message={deleting ? deleteMessage(deleting, credentials ?? []) : ''}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) {
            await del.mutateAsync(deleting.id);
          }
        }}
        open={deleting !== null}
        title="Delete provider credential"
      />
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
    // null clears the column on the server; undefined keeps the existing value.
    apiBase?: string | null;
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
  const { error, saving, submit } = useIntegrationConfigForm();
  const { data: teams } = useTeams();

  const [clientError, setClientError] = useState<string | null>(null);
  const providerName = (existing?.provider ?? provider).trim();
  const needsApiBase =
    providerName !== '' && !BUILTIN_PROVIDERS.includes(providerName as BuiltinProvider);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = existing
      ? needsApiBase && !apiBase.trim()
        ? `${providerName} is not a built-in provider, so it needs an API base URL.`
        : null
      : !provider.trim()
        ? 'Enter a provider name.'
        : needsApiBase && !apiBase.trim()
          ? `${providerName} is not a built-in provider, so it needs an API base URL.`
          : scope === 'TEAM' && !teamId
            ? 'Choose a team for a team-scoped credential.'
            : !apiKey.trim()
              ? 'Enter the API key.'
              : null;
    setClientError(problem);
    if (problem) {
      return;
    }
    void submit(() => {
      if (existing) {
        // Update: only apiBase + apiKey are editable. When the user clears
        // apiBase, send `null` explicitly so the gateway nulls the column —
        // omitting the key entirely would leave the stale URL in place.
        const apiBaseChanged = apiBase !== (existing.apiBase ?? '');
        return onSave({
          ...(apiBaseChanged && { apiBase: apiBase || null }),
          ...(apiKey && { apiKey }),
        });
      }
      return onSave({
        apiKey,
        provider,
        scope,
        ...(scope === 'TEAM' && { teamId }),
        ...(apiBase && { apiBase }),
      });
    });
  };

  return (
    <Modal
      onClose={onClose}
      open
      title={existing ? `Edit ${existing.provider}` : 'New provider credential'}
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        {!existing && (
          <>
            <div>
              <Input
                className="font-mono text-xs"
                hint={
                  BUILTIN_PROVIDERS.includes(provider as BuiltinProvider)
                    ? BUILTIN_PROVIDER_HINTS[provider as BuiltinProvider]
                    : provider
                      ? 'Custom provider — treated as OpenAI-compatible. An API base URL is required.'
                      : 'Built-in: anthropic, openai, google (no API base needed). Anything else is OpenAI-compatible and requires an API base URL.'
                }
                id="provider"
                label="Provider name"
                list="provider-suggestions"
                onChange={(e) => setProvider(e.target.value)}
                placeholder="anthropic / openai / google / openrouter / ..."
                value={provider}
              />
              <datalist id="provider-suggestions">
                {BUILTIN_PROVIDERS.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
            <Select
              id="scope"
              label="Scope"
              onChange={(v) => {
                if (v === 'GLOBAL' || v === 'TEAM') {
                  setScope(v);
                }
              }}
              options={[
                { label: 'Global (used by every team unless overridden)', value: 'GLOBAL' },
                { label: 'Team', value: 'TEAM' },
              ]}
              value={scope}
            />
            {scope === 'TEAM' && (
              <Combobox
                id="teamId"
                label="Team"
                onChange={(v) => setTeamId(v)}
                options={(teams ?? []).map((t) => ({ label: t.name, value: t.id }))}
                placeholder="Choose a team…"
                value={teamId}
              />
            )}
          </>
        )}
        <Input
          className="font-mono text-xs"
          id="apiBase"
          label={needsApiBase ? 'API base URL' : 'API base URL (optional)'}
          onChange={(e) => setApiBase(e.target.value)}
          placeholder="https://opencode.ai/zen/go/v1"
          value={apiBase}
        />
        <Input
          className="font-mono text-xs"
          id="apiKey"
          label={existing ? 'API key (leave blank to keep existing)' : 'API key'}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={existing ? `····${existing.lastFour}` : 'sk-...'}
          type="password"
          value={apiKey}
        />
        <Alert variant="warning">Stored encrypted; it can't be shown again after saving.</Alert>
        {(clientError ?? error) && <Alert>{clientError ?? error}</Alert>}
        <ModalFooter
          isPending={saving}
          onCancel={onClose}
          pendingLabel="Saving…"
          submitLabel={existing ? 'Save changes' : 'Create credential'}
        />
      </form>
    </Modal>
  );
}
