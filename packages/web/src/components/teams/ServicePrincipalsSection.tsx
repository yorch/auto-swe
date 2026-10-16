'use client';

import {
  SERVICE_TOKEN_MAX_DAYS,
  SERVICE_TOKEN_MAX_LIVE,
  SERVICE_TOKEN_SCOPES,
  type ServiceTokenScope,
} from '@auto-swe/shared/types/api';
import { useEffect, useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { Textarea } from '@/components/ui/Textarea';
import {
  type ServicePrincipalInput,
  type ServicePrincipalSummary,
  type ServiceTokenCreated,
  useCreateServicePrincipal,
  useCreateServiceToken,
  useDeleteServicePrincipal,
  useRevokeServiceToken,
  useServicePrincipals,
  useServiceTokens,
  useUpdateServicePrincipal,
} from '@/hooks/useServicePrincipals';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';
import { formatDate, plural } from '@/lib/utils';

/** A repository the team can put on an allowlist: its own, or one shared with it. */
export interface GrantableRepo {
  id: string;
  label: string;
}

const SCOPE_HINTS: Record<ServiceTokenScope, string> = {
  'runs:agent':
    'Start agent runs: any prompt, any launchable agent, on a repository on its list. Grant only to a caller you trust with that',
  'runs:cancel': 'Cancel runs this principal started',
  'runs:launch': 'Start runs of the templates on its list',
  'runs:read': 'List and read runs this principal started',
};

/** Toggle `id` in a list. */
function toggle(list: string[], id: string, on: boolean): string[] {
  return on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
}

/**
 * The team page's "Service principals" card: machine identities that start runs on the team's
 * behalf with tokens of their own, what each may launch, and its tokens. Shown to those who may
 * manage the team; the gateway enforces the same bar.
 */
export function ServicePrincipalsSection({
  teamId,
  repositories,
}: {
  teamId: string;
  repositories: GrantableRepo[];
}) {
  const { data, error, isError, isFetching, isLoading, refetch } = useServicePrincipals(teamId);
  const update = useUpdateServicePrincipal(teamId);
  const remove = useDeleteServicePrincipal(teamId);
  const [editing, setEditing] = useState<ServicePrincipalSummary | 'new' | null>(null);
  const [tokensFor, setTokensFor] = useState<ServicePrincipalSummary | null>(null);
  const [deleting, setDeleting] = useState<ServicePrincipalSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const principals = data ?? [];

  return (
    <Card className="p-4 sm:p-6">
      <CardHeader>
        <CardTitle>Service principals</CardTitle>
        <Button onClick={() => setEditing('new')} size="sm" variant="primary">
          <Icon name="plus" size={14} />
          New principal
        </Button>
      </CardHeader>
      <p className="mb-4 text-sm text-paper-400">
        Machine identities that start and follow runs for this team with tokens of their own. A
        principal may launch only on the repositories and templates you put on its lists, and its
        runs use the platform credential.
      </p>
      {actionError && (
        <Alert className="mb-3" variant="error">
          {actionError}
        </Alert>
      )}
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="service principals"
        onRetry={() => void refetch()}
        rows={2}
      >
        {principals.length === 0 ? (
          <EmptyState
            hint="Create one for a CI pipeline or another service that should start runs without a person's token."
            icon="key"
            title="No service principals yet"
          />
        ) : (
          <Table stacked>
            <THead>
              <Th className="pl-0" variant="plain">
                Principal
              </Th>
              <Th variant="plain">May launch on</Th>
              <Th variant="plain">Limits</Th>
              <Th variant="plain">Tokens</Th>
              <Th className="pr-0" variant="plain">
                <span className="sr-only">Actions</span>
              </Th>
            </THead>
            <tbody>
              {principals.map((p) => (
                <TRow hover key={p.id}>
                  <Td className="py-3 pr-4" primary>
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-paper-100">{p.name}</span>
                      {p.disabledAt && (
                        <Badge tone="muted" variant="outline">
                          Disabled
                        </Badge>
                      )}
                    </div>
                    {p.description && (
                      <div className="mt-0.5 text-xs font-normal text-paper-500">
                        {p.description}
                      </div>
                    )}
                  </Td>
                  <Td className="px-4 py-3 text-sm text-paper-300" label="May launch on">
                    {p.connectionIds.length === 1
                      ? '1 repository'
                      : `${p.connectionIds.length} repositories`}{' '}
                    · {plural(p.templateIds.length, 'template')}
                  </Td>
                  <Td className="px-4 py-3 text-sm text-paper-400" label="Limits">
                    {p.maxRunsPerDay}/day · {p.maxInFlight} in flight
                  </Td>
                  <Td className="px-4 py-3 text-sm text-paper-400" label="Tokens">
                    {p.liveTokenCount} live
                  </Td>
                  <Td align="right" className="py-3 pl-4">
                    <ActionMenu
                      items={[
                        {
                          icon: 'edit',
                          id: 'edit',
                          label: 'Edit',
                          onAction: () => setEditing(p),
                        },
                        {
                          icon: 'key',
                          id: 'tokens',
                          label: 'Tokens',
                          onAction: () => setTokensFor(p),
                        },
                        {
                          disabled: update.isPending,
                          icon: p.disabledAt ? 'play' : 'pause',
                          id: 'toggle',
                          label: p.disabledAt ? 'Enable' : 'Disable',
                          onAction: () => {
                            setActionError(null);
                            update
                              .mutateAsync({ disabled: !p.disabledAt, id: p.id })
                              .catch((err) => setActionError(errMsg(err, 'Update failed')));
                          },
                        },
                        {
                          icon: 'trash',
                          id: 'delete',
                          label: 'Delete',
                          onAction: () => setDeleting(p),
                          tone: 'danger',
                        },
                      ]}
                      label={`Actions for service principal ${p.name}`}
                    />
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </QueryBoundary>

      <PrincipalFormModal
        onClose={() => setEditing(null)}
        open={editing !== null}
        principal={editing === 'new' ? null : editing}
        repositories={repositories}
        teamId={teamId}
      />
      {/* Keyed so each principal opens on a clean form and no earlier plaintext. */}
      <TokensModal
        key={tokensFor?.id ?? 'none'}
        onClose={() => setTokensFor(null)}
        principal={tokensFor}
        teamId={teamId}
      />
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message={`Delete "${deleting?.name}"? Its tokens stop working at once. Runs it started keep running, no longer attributed to it.`}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) {
            await remove.mutateAsync(deleting.id);
          }
        }}
        open={deleting !== null}
        pendingLabel="Deleting…"
        title="Delete service principal?"
      />
    </Card>
  );
}

function PrincipalFormModal({
  open,
  onClose,
  principal,
  teamId,
  repositories,
}: {
  open: boolean;
  onClose: () => void;
  principal: ServicePrincipalSummary | null;
  teamId: string;
  repositories: GrantableRepo[];
}) {
  const create = useCreateServicePrincipal(teamId);
  const update = useUpdateServicePrincipal(teamId);
  const templates = useWorkflowTemplates(teamId);
  const [form, setForm] = useState<ServicePrincipalInput>(emptyForm());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setForm(
      principal
        ? {
            connectionIds: principal.connectionIds,
            description: principal.description,
            maxInFlight: principal.maxInFlight,
            maxRunsPerDay: principal.maxRunsPerDay,
            name: principal.name,
            templateIds: principal.templateIds,
          }
        : emptyForm()
    );
  }, [open, principal]);

  // Global templates and this team's, as the gateway allows; archived ones cannot run.
  const grantableTemplates = (templates.data ?? []).filter(
    (t) => t.status !== 'ARCHIVED' && (t.team === null || t.team.id === teamId)
  );
  const pending = create.isPending || update.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = { ...form, description: form.description?.trim() || null, name: form.name.trim() };
    try {
      if (principal) {
        await update.mutateAsync({ id: principal.id, ...body });
      } else {
        await create.mutateAsync(body);
      }
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Failed to save the service principal'));
    }
  }

  return (
    <Modal
      onClose={onClose}
      open={open}
      size="lg"
      subtitle="Adding a repository is a launch decision taken as you: you must be able to start work on it yourself."
      title={principal ? `Edit ${principal.name}` : 'New service principal'}
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        <Input
          autoFocus
          label="Name"
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="e.g. release-pipeline"
          required
          value={form.name}
        />
        <Textarea
          label="Description"
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="What calls with this identity"
          value={form.description ?? ''}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            hint="Runs it may start in any 24 hours"
            label="Runs per day"
            max={10_000}
            min={1}
            onChange={(e) => setForm({ ...form, maxRunsPerDay: Number(e.target.value) })}
            required
            type="number"
            value={String(form.maxRunsPerDay)}
          />
          <Input
            hint="Runs of its own in flight at once"
            label="In flight"
            max={100}
            min={1}
            onChange={(e) => setForm({ ...form, maxInFlight: Number(e.target.value) })}
            required
            type="number"
            value={String(form.maxInFlight)}
          />
        </div>
        <fieldset className="space-y-2">
          <legend className="label-mono mb-2">Repositories it may launch on</legend>
          {repositories.length === 0 ? (
            <p className="text-sm text-paper-500">
              This team has no active repositories of its own or shared with it.
            </p>
          ) : (
            repositories.map((r) => (
              <Checkbox
                checked={form.connectionIds.includes(r.id)}
                key={r.id}
                label={<span className="font-mono text-sm">{r.label}</span>}
                onChange={(e) =>
                  setForm({
                    ...form,
                    connectionIds: toggle(form.connectionIds, r.id, e.target.checked),
                  })
                }
              />
            ))
          )}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="label-mono mb-2">Templates it may run</legend>
          {grantableTemplates.length === 0 ? (
            <p className="text-sm text-paper-500">No templates available to this team.</p>
          ) : (
            grantableTemplates.map((t) => (
              <Checkbox
                checked={form.templateIds.includes(t.id)}
                hint={t.team ? undefined : 'Global'}
                key={t.id}
                label={t.name}
                onChange={(e) =>
                  setForm({
                    ...form,
                    templateIds: toggle(form.templateIds, t.id, e.target.checked),
                  })
                }
              />
            ))
          )}
        </fieldset>
        {error && <Alert variant="error">{error}</Alert>}
        <ModalFooter
          disabled={!form.name.trim()}
          isPending={pending}
          onCancel={onClose}
          pendingLabel="Saving…"
          submitLabel={principal ? 'Save' : 'Create'}
        />
      </form>
    </Modal>
  );
}

function emptyForm(): ServicePrincipalInput {
  return {
    connectionIds: [],
    description: null,
    maxInFlight: 5,
    maxRunsPerDay: 50,
    name: '',
    templateIds: [],
  };
}

function TokensModal({
  principal,
  teamId,
  onClose,
}: {
  principal: ServicePrincipalSummary | null;
  teamId: string;
  onClose: () => void;
}) {
  const id = principal?.id ?? '';
  const tokens = useServiceTokens(teamId, principal?.id ?? null);
  const create = useCreateServiceToken(teamId, id);
  const revoke = useRevokeServiceToken(teamId, id);
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [scopes, setScopes] = useState<ServiceTokenScope[]>(['runs:launch', 'runs:read']);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ServiceTokenCreated | null>(null);

  const now = Date.now();
  const list = tokens.data ?? [];
  const live = list.filter((t) => !t.revokedAt && new Date(t.expiresAt).getTime() > now);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await create.mutateAsync({
        expiresInDays: Number(days),
        name: name.trim(),
        scopes,
      });
      setRevealed(res.data);
      setName('');
    } catch (err) {
      setError(errMsg(err, 'Failed to create the token'));
    }
  }

  return (
    <Modal
      onClose={onClose}
      open={principal !== null}
      size="lg"
      subtitle={`Every token expires, within ${SERVICE_TOKEN_MAX_DAYS} days. A principal holds at most ${SERVICE_TOKEN_MAX_LIVE} live tokens, so one can be rotated in before the other is revoked.`}
      title={principal ? `Tokens for ${principal.name}` : 'Tokens'}
    >
      <div className="space-y-5">
        {revealed && (
          <div className="space-y-3">
            <Alert title="This is the only time you will see it" variant="warning">
              auto-swe stores only a hash. Copy the token into the calling service's secret store
              now.
            </Alert>
            <div className="rounded-lg border border-warning-400/40 bg-ink-950/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="label-mono">Token</span>
                <CopyButton value={revealed.token} />
              </div>
              <code className="block break-all font-mono text-sm leading-relaxed text-paper-50 select-all">
                {revealed.token}
              </code>
            </div>
          </div>
        )}

        {list.length > 0 && (
          <Table stacked>
            <THead>
              <Th className="pl-0" variant="plain">
                Token
              </Th>
              <Th variant="plain">Scopes</Th>
              <Th variant="plain">Last used</Th>
              <Th variant="plain">Expires</Th>
              <Th className="pr-0" variant="plain">
                <span className="sr-only">Actions</span>
              </Th>
            </THead>
            <tbody>
              {list.map((t) => {
                const expired = new Date(t.expiresAt).getTime() <= now;
                return (
                  <TRow key={t.id}>
                    <Td className="py-3 pr-4" primary>
                      <div className={t.revokedAt ? 'text-paper-400 line-through' : 'font-medium'}>
                        {t.name}
                      </div>
                      <code className="font-mono text-xs text-paper-500">{t.prefix}…</code>
                    </Td>
                    <Td className="px-4 py-3 font-mono text-xs text-paper-300" label="Scopes">
                      {t.scopes.join(' ')}
                    </Td>
                    <Td className="px-4 py-3 text-sm text-paper-400" label="Last used">
                      {t.lastUsedAt ? <RelativeTime value={t.lastUsedAt} /> : 'Never'}
                    </Td>
                    <Td className="px-4 py-3 text-sm text-paper-400" label="Expires">
                      {t.revokedAt ? 'Revoked' : expired ? 'Expired' : formatDate(t.expiresAt)}
                    </Td>
                    <Td align="right" className="py-3 pl-4">
                      {!t.revokedAt && !expired && (
                        <Button
                          disabled={revoke.isPending}
                          onClick={() => {
                            setError(null);
                            revoke
                              .mutateAsync(t.id)
                              .catch((err) => setError(errMsg(err, 'Failed to revoke')));
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          Revoke
                        </Button>
                      )}
                    </Td>
                  </TRow>
                );
              })}
            </tbody>
          </Table>
        )}

        {live.length < SERVICE_TOKEN_MAX_LIVE ? (
          <form className="space-y-4 border-t border-ink-600 pt-4" onSubmit={handleCreate}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                label="Name"
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. github-actions"
                required
                value={name}
              />
              <Input
                hint={`1 to ${SERVICE_TOKEN_MAX_DAYS} days`}
                label="Expires in (days)"
                max={SERVICE_TOKEN_MAX_DAYS}
                min={1}
                onChange={(e) => setDays(e.target.value)}
                required
                type="number"
                value={days}
              />
            </div>
            <fieldset className="space-y-2">
              <legend className="label-mono mb-2">Scopes</legend>
              {SERVICE_TOKEN_SCOPES.map((scope) => (
                <Checkbox
                  checked={scopes.includes(scope)}
                  hint={SCOPE_HINTS[scope]}
                  key={scope}
                  label={<span className="font-mono text-sm">{scope}</span>}
                  onChange={(e) =>
                    setScopes(
                      e.target.checked
                        ? [...new Set([...scopes, scope])]
                        : scopes.filter((s) => s !== scope)
                    )
                  }
                />
              ))}
            </fieldset>
            {error && <Alert variant="error">{error}</Alert>}
            <ModalFooter
              cancelLabel="Close"
              disabled={!name.trim() || scopes.length === 0}
              isPending={create.isPending}
              onCancel={onClose}
              pendingLabel="Creating…"
              submitLabel="Create token"
            />
          </form>
        ) : (
          <>
            <Alert variant="info">
              This principal holds {SERVICE_TOKEN_MAX_LIVE} live tokens. Revoke one to create
              another.
            </Alert>
            <ModalFooter cancelLabel="Close" onCancel={onClose} />
          </>
        )}
      </div>
    </Modal>
  );
}
