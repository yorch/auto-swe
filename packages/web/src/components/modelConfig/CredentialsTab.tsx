'use client';

import { useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import {
  type ProviderCredentialRow,
  useAdminCreateCredential,
  useAdminCredentials,
  useAdminDeleteCredential,
  useAdminTestCredential,
  useAdminUpdateCredential,
} from '@/hooks/useModelConfig';
import { useReadiness } from '@/hooks/useReadiness';
import { useTeams } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';
import { humanizeKey } from '@/lib/govLabels';

type ProbeResult = { ok: boolean; status?: number; error?: string };

const BUILTIN_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
type BuiltinProvider = (typeof BUILTIN_PROVIDERS)[number];

const BUILTIN_PROVIDER_HINTS: Record<BuiltinProvider, string> = {
  anthropic: 'Built-in, no API base needed. Key format: sk-ant-…',
  google: 'Built-in, no API base needed. The key is the Gemini API key from Google AI Studio.',
  openai: 'Built-in, no API base needed. Key format: sk-…',
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

/**
 * "Used by 2 agents and embeddings: Implementer, Reviewer". The readiness payload lists the
 * embedding model under the key `embeddings`, which is not an agent, so it is counted apart.
 */
export function usedByLabel(usedBy: string[]): string {
  const agents = usedBy.filter((key) => key !== 'embeddings');
  const embeddings = agents.length !== usedBy.length;
  if (agents.length === 0) {
    return embeddings ? 'Used by embeddings' : 'Not used by any agent';
  }
  const count = `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`;
  const names = agents.slice(0, 4).map(humanizeKey).join(', ');
  const more = agents.length > 4 ? ` and ${agents.length - 4} more` : '';
  return `Used by ${count}${embeddings ? ' and embeddings' : ''}: ${names}${more}`;
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
  const {
    data: credentials,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useAdminCredentials();
  const [editing, setEditing] = useState<ProviderCredentialRow | null>(null);
  const [creating, setCreating] = useState(false);
  // Provider prefilled when "Add credential" is clicked on a missing provider.
  const [newProvider, setNewProvider] = useState('');
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
  const { data: readiness } = useReadiness();
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

  const openCreate = (provider = '') => {
    setNewProvider(provider);
    setCreating(true);
  };
  const missing = readiness?.providers.filter((p) => !p.present).length ?? 0;

  return (
    <div className="space-y-6">
      {readiness && readiness.providers.length > 0 && (
        <Card className="p-5 sm:p-6">
          <CardHeader className="items-start">
            <CardTitle eyebrow="Checklist">Providers your agents use</CardTitle>
            <Badge dot tone={missing > 0 ? 'brick' : 'moss'} variant="outline">
              {missing > 0 ? `${missing} missing` : 'All covered'}
            </Badge>
          </CardHeader>
          <ul
            aria-label="Providers your agents use"
            className="divide-y divide-ink-600 rounded-lg border border-ink-500/60"
          >
            {readiness.providers.map((p) => (
              <li
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
                key={p.provider}
              >
                <Icon
                  className={p.present ? 'text-moss-400' : 'text-brick-400'}
                  name={p.present ? 'checkCircle' : 'warning'}
                  size={18}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px] font-medium text-paper-100">
                      {p.provider}
                    </span>
                    <Badge tone={p.present ? 'moss' : 'brick'}>
                      {p.present ? 'Credential present' : 'Credential missing'}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-paper-500">{usedByLabel(p.usedBy)}</div>
                </div>
                {!p.present && (
                  <Button onClick={() => openCreate(p.provider)} size="sm" variant="secondary">
                    <Icon name="plus" size={14} />
                    Add credential
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-5 sm:p-6">
        <CardHeader className="items-start">
          <CardTitle eyebrow="Provider credentials">API keys</CardTitle>
          {(credentials ?? []).length > 0 && (
            <Button onClick={() => openCreate()} size="sm" variant="primary">
              <Icon name="plus" size={14} />
              New credential
            </Button>
          )}
        </CardHeader>
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="credentials"
          loading={<SkeletonRows rows={3} />}
          onRetry={() => void refetch()}
        >
          {(credentials ?? []).length === 0 ? (
            <EmptyState
              action={
                <Button onClick={() => openCreate()} size="sm" variant="primary">
                  New credential
                </Button>
              }
              bordered
              hint="Add one before any agent can call a model. Keys are stored encrypted."
              icon="key"
              title="No provider credentials yet"
            />
          ) : (
            <Table stacked>
              <THead>
                <Th className="pl-0" variant="plain">
                  Provider
                </Th>
                <Th variant="plain">Scope</Th>
                <Th variant="plain">Key</Th>
                <Th variant="plain">Last test</Th>
                <Th className="pr-0" variant="plain">
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <tbody>
                {(credentials ?? []).map((c) => {
                  const probe = probeResults[c.id];
                  return (
                    <TRow key={c.id}>
                      <Td className="py-2.5 pr-4" primary>
                        <div className="font-mono text-[13px] font-medium text-paper-100">
                          {c.provider}
                        </div>
                        {c.apiBase && (
                          <div
                            className="mt-0.5 max-w-xs truncate font-mono text-xs text-paper-500"
                            title={c.apiBase}
                          >
                            {c.apiBase}
                          </div>
                        )}
                      </Td>
                      <Td className="px-4 py-2.5" label="Scope">
                        <Badge tone={c.scope === 'GLOBAL' ? 'neutral' : 'dust'}>
                          {c.scope === 'GLOBAL' ? 'Platform-wide' : 'Team'}
                        </Badge>
                        {c.teamId && (
                          <span className="ml-1.5 text-xs text-paper-400">
                            {teamName(c.teamId)}
                          </span>
                        )}
                      </Td>
                      <Td className="px-4 py-2.5 font-mono text-xs text-paper-300" label="Key">
                        {c.maskedKey}
                      </Td>
                      <Td className="px-4 py-2.5" label="Last test">
                        {probe ? (
                          <Badge dot tone={probe.ok ? 'moss' : 'brick'}>
                            {probe.ok
                              ? `OK (${probe.status})`
                              : (probe.error ?? `HTTP ${probe.status}`)}
                          </Badge>
                        ) : (
                          <span className="text-xs text-paper-500">Not tested</span>
                        )}
                      </Td>
                      <Td className="py-2.5 pl-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            aria-label={`Test the ${c.provider} credential`}
                            disabled={!!probePending[c.id]}
                            onClick={() => handleTest(c.id)}
                            size="sm"
                          >
                            {probePending[c.id] ? 'Testing…' : 'Test'}
                          </Button>
                          <ActionMenu
                            items={[
                              {
                                icon: 'edit',
                                id: 'edit',
                                label: 'Edit',
                                onAction: () => {
                                  clearProbeForRow(c.id);
                                  setEditing(c);
                                },
                              },
                              {
                                icon: 'trash',
                                id: 'delete',
                                label: 'Delete',
                                onAction: () => setDeleting(c),
                                tone: 'danger',
                              },
                            ]}
                            label={`More actions for the ${c.provider} credential`}
                          />
                        </div>
                      </Td>
                    </TRow>
                  );
                })}
              </tbody>
            </Table>
          )}
        </QueryBoundary>
      </Card>
      {(creating || editing) && (
        <CredentialModal
          existing={editing}
          initialProvider={newProvider}
          onClose={() => {
            setCreating(false);
            setNewProvider('');
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
    </div>
  );
}

function CredentialModal({
  existing,
  initialProvider = '',
  onClose,
  onSave,
}: {
  existing: ProviderCredentialRow | null;
  initialProvider?: string;
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
  const [provider, setProvider] = useState(existing?.provider ?? initialProvider);
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
                className="font-mono"
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
          className="font-mono"
          id="apiBase"
          label={needsApiBase ? 'API base URL' : 'API base URL (optional)'}
          onChange={(e) => setApiBase(e.target.value)}
          placeholder="https://opencode.ai/zen/go/v1"
          value={apiBase}
        />
        <Input
          className="font-mono"
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
