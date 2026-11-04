'use client';

import { useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { CopyButton } from '@/components/ui/CopyButton';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type PatCreated,
  useCreatePat,
  usePersonalAccessTokens,
  useRevokePat,
} from '@/hooks/usePats';
import { errMsg } from '@/lib/errors';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { SettingsSection } from './SettingsSection';

function TokenStatus({ revoked, expired }: { revoked: boolean; expired: boolean }) {
  if (revoked) {
    return (
      <Badge dot tone="danger" variant="outline">
        Revoked
      </Badge>
    );
  }
  if (expired) {
    return (
      <Badge dot tone="warning" variant="outline">
        Expired
      </Badge>
    );
  }
  return (
    <Badge dot tone="success" variant="outline">
      Active
    </Badge>
  );
}

/** A relative time with the exact one on hover, or a muted dash. */
function When({ value, empty = '—' }: { value: string | null | undefined; empty?: string }) {
  if (!value) {
    return <span className="text-paper-600">{empty}</span>;
  }
  return (
    <time className="whitespace-nowrap" dateTime={value} title={formatDate(value)}>
      {formatRelativeTime(value)}
    </time>
  );
}

/**
 * The API tokens section of the settings page, header included: the "New
 * token" action belongs in the section header, so the section owns it.
 */
export function AccessTokensSection() {
  const {
    data: tokens,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = usePersonalAccessTokens();
  const create = useCreatePat();
  const revoke = useRevokePat();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<string>('90');
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>();
  const [showRevoked, setShowRevoked] = useState(false);
  const [revealed, setRevealed] = useState<PatCreated | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Native validation passes whitespace, and the server would reject the trimmed empty name
    // with a generic message, so the field says it.
    if (!name.trim()) {
      setNameError('Give the token a name.');
      return;
    }
    setNameError(undefined);
    try {
      const days = expiresInDays.trim() ? Number(expiresInDays) : undefined;
      const res = await create.mutateAsync({
        expiresInDays: days && Number.isFinite(days) ? days : undefined,
        name: name.trim(),
      });
      setRevealed(res.data);
      setName('');
      setExpiresInDays('90');
      setCreating(false);
    } catch (err) {
      setError(errMsg(err, 'Failed to create token'));
    }
  }

  const all = tokens ?? [];
  const revokedCount = all.filter((t) => t.revokedAt).length;
  // Revoked tokens are history: hidden until asked for, so the list is what still works.
  const list = showRevoked ? all : all.filter((t) => !t.revokedAt);

  return (
    <>
      <SettingsSection
        actions={
          <Button onClick={() => setCreating(true)} size="sm" variant="primary">
            <Icon name="plus" size={14} />
            New token
          </Button>
        }
        description={
          <>
            Personal access tokens for the auto-swe CLI and the REST API, set as{' '}
            <code className="font-mono text-xs text-paper-300">AUTO_SWE_TOKEN</code>.
          </>
        }
        icon="key"
        id="api-tokens"
        title="API tokens"
      >
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="tokens"
          onRetry={() => void refetch()}
          rows={3}
        >
          {revokedCount > 0 && (
            <div className="flex justify-end pt-2">
              <Button onClick={() => setShowRevoked((v) => !v)} size="sm" variant="ghost">
                {showRevoked ? 'Hide revoked tokens' : `Show revoked tokens (${revokedCount})`}
              </Button>
            </div>
          )}
          {list.length === 0 ? (
            <EmptyState
              action={
                <Button onClick={() => setCreating(true)} size="sm">
                  <Icon name="plus" size={14} />
                  Create a token
                </Button>
              }
              hint="Create one to sign the CLI in, or to call the API from a script or CI job."
              icon="key"
              title="No tokens yet"
            />
          ) : (
            <DataTable
              actions={(t) =>
                !t.revokedAt && (
                  <ActionMenu
                    items={[
                      {
                        icon: 'trash',
                        id: 'revoke',
                        label: 'Revoke token',
                        onAction: () => setRevoking({ id: t.id, name: t.name }),
                        tone: 'danger',
                      },
                    ]}
                    label={`Actions for token ${t.name}`}
                  />
                )
              }
              columns={[
                {
                  cell: (t) => (
                    <span className={t.revokedAt ? 'text-paper-400 line-through' : undefined}>
                      {t.name}
                    </span>
                  ),
                  header: 'Name',
                  id: 'name',
                  primary: true,
                  secondary: (t) => <code className="font-mono">{t.prefix}…</code>,
                },
                {
                  cell: (t) => (
                    <span className="text-sm text-paper-400">
                      <When value={t.createdAt} />
                    </span>
                  ),
                  header: 'Created',
                  id: 'created',
                },
                {
                  cell: (t) => (
                    <span className="text-sm text-paper-400">
                      <When empty="Never" value={t.lastUsedAt} />
                    </span>
                  ),
                  header: 'Last used',
                  id: 'last-used',
                },
                {
                  cell: (t) => (
                    <span className="text-sm text-paper-400">
                      <When empty="Never" value={t.expiresAt} />
                    </span>
                  ),
                  header: 'Expires',
                  id: 'expires',
                },
                {
                  cell: (t) => (
                    <TokenStatus
                      expired={!!t.expiresAt && new Date(t.expiresAt) < new Date()}
                      revoked={!!t.revokedAt}
                    />
                  ),
                  header: 'Status',
                  id: 'status',
                },
              ]}
              getRowId={(t) => t.id}
              revealActions={false}
              rows={list}
            />
          )}
        </QueryBoundary>
      </SettingsSection>

      <Modal
        onClose={() => setCreating(false)}
        open={creating}
        subtitle="Tokens authenticate the CLI and the API as you. The value is shown once, right after you create it, and is never stored."
        title="New API token"
      >
        <form className="space-y-5" noValidate onSubmit={handleCreate}>
          <Alert variant="info">A token can do everything you can. Keep it secret.</Alert>
          <Input
            autoFocus
            error={nameError}
            hint="Something that says where it is used, so you know what breaks if you revoke it"
            label="Name"
            maxLength={100}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(undefined);
            }}
            placeholder="e.g. laptop, CI deploy job"
            required
            value={name}
          />
          <Input
            hint={
              expiresInDays.trim()
                ? '1 to 365 days.'
                : 'No expiry: this token works until you revoke it. A date limits the damage if it leaks.'
            }
            label="Expires in (days)"
            max={365}
            min={1}
            onChange={(e) => setExpiresInDays(e.target.value)}
            placeholder="90"
            type="number"
            value={expiresInDays}
          />
          {error && <Alert variant="error">{error}</Alert>}
          <ModalFooter
            isPending={create.isPending}
            onCancel={() => setCreating(false)}
            pendingLabel="Creating…"
            submitLabel="Create token"
          />
        </form>
      </Modal>

      <Modal
        closeOnBackdropClick={false}
        onClose={() => setRevealed(null)}
        open={revealed !== null}
        subtitle={revealed ? `Token “${revealed.name}” is ready to use.` : undefined}
        title="Copy your new token"
      >
        {revealed && (
          <div className="space-y-5">
            <Alert title="This is the only time you will see it" variant="warning">
              auto-swe stores only a hash. Copy the token now and keep it in your secret manager; if
              you lose it, revoke it and create another.
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
            <div>
              <div className="label-mono mb-1.5">Use it from your shell</div>
              <pre className="overflow-x-auto rounded-lg border border-ink-500 bg-ink-950/70 px-3 py-2.5 font-mono text-xs text-paper-300">
                export AUTO_SWE_TOKEN=&lt;paste the token&gt;
              </pre>
            </div>
            <div className="flex justify-end border-t border-ink-600 pt-4">
              <Button onClick={() => setRevealed(null)} variant="primary">
                Done, I've copied it
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        confirmLabel="Revoke"
        dangerous
        message={`Anything using “${revoking?.name}” stops working right away. This cannot be undone.`}
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          // Awaited so ConfirmModal keeps the dialog open and shows a failure.
          if (revoking) {
            await revoke.mutateAsync(revoking.id);
          }
        }}
        open={revoking !== null}
        pendingLabel="Revoking…"
        title="Revoke this token?"
      />
    </>
  );
}
