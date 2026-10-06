'use client';

import { useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
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
      <Badge dot tone="brick" variant="outline">
        Revoked
      </Badge>
    );
  }
  if (expired) {
    return (
      <Badge dot tone="amber" variant="outline">
        Expired
      </Badge>
    );
  }
  return (
    <Badge dot tone="moss" variant="outline">
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
  const [revealed, setRevealed] = useState<PatCreated | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
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

  const list = tokens ?? [];

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
            <code className="font-mono text-[12px] text-paper-300">AUTO_SWE_TOKEN</code>.
          </>
        }
        icon="key"
        id="api-tokens"
        title="API tokens"
      >
        {isLoading ? (
          <SkeletonRows rows={3} />
        ) : (
          <QueryBoundary
            compact
            error={loadError}
            isError={isError}
            isFetching={isFetching}
            isLoading={false}
            label="tokens"
            onRetry={() => void refetch()}
          >
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
              <Table className="-mx-1" stacked>
                <THead>
                  <Th className="pl-1">Name</Th>
                  <Th>Created</Th>
                  <Th>Last used</Th>
                  <Th>Expires</Th>
                  <Th>Status</Th>
                  <Th className="pr-1">
                    <span className="sr-only">Actions</span>
                  </Th>
                </THead>
                <tbody>
                  {list.map((t) => {
                    const revoked = !!t.revokedAt;
                    const expired = !!t.expiresAt && new Date(t.expiresAt) < new Date();
                    return (
                      <TRow key={t.id}>
                        <Td className="py-3 pr-4 pl-1" primary>
                          <div
                            className={
                              revoked ? 'text-paper-400 line-through' : 'font-medium text-paper-100'
                            }
                          >
                            {t.name}
                          </div>
                          <code className="font-mono text-xs text-paper-500">{t.prefix}…</code>
                        </Td>
                        <Td className="px-4 py-3 text-[13px] text-paper-400" label="Created">
                          <When value={t.createdAt} />
                        </Td>
                        <Td className="px-4 py-3 text-[13px] text-paper-400" label="Last used">
                          <When empty="Never" value={t.lastUsedAt} />
                        </Td>
                        <Td className="px-4 py-3 text-[13px] text-paper-400" label="Expires">
                          <When empty="Never" value={t.expiresAt} />
                        </Td>
                        <Td className="px-4 py-3" label="Status">
                          <TokenStatus expired={expired} revoked={revoked} />
                        </Td>
                        <Td align="right" className="py-3 pr-1 pl-4">
                          {!revoked && (
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
                          )}
                        </Td>
                      </TRow>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </QueryBoundary>
        )}
      </SettingsSection>

      <Modal
        onClose={() => setCreating(false)}
        open={creating}
        subtitle="Tokens authenticate the CLI and the API as you. The value is shown once, right after you create it, and is never stored."
        title="New API token"
      >
        <form className="space-y-5" onSubmit={handleCreate}>
          <Input
            autoFocus
            hint="Something that says where it is used, so you know what breaks if you revoke it"
            label="Name"
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. laptop, CI deploy job"
            required
            value={name}
          />
          <Input
            hint="1 to 365 days. Leave blank for a token that never expires."
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
        subtitle={revealed ? `Token "${revealed.name}" is ready to use.` : undefined}
        title="Copy your new token"
      >
        {revealed && (
          <div className="space-y-5">
            <Alert title="This is the only time you will see it" variant="warning">
              auto-swe stores only a hash. Copy the token now and keep it in your secret manager; if
              you lose it, revoke it and create another.
            </Alert>
            <div className="rounded-lg border border-ember-400/40 bg-ink-950/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="label-mono">Token</span>
                <CopyButton value={revealed.token} />
              </div>
              <code className="block break-all font-mono text-sm leading-relaxed text-ember-100 select-all">
                {revealed.token}
              </code>
            </div>
            <div>
              <div className="label-mono mb-1.5">Use it from your shell</div>
              <pre className="overflow-x-auto rounded-lg border border-ink-500 bg-ink-950/70 px-3 py-2.5 font-mono text-xs text-paper-300">
                export AUTO_SWE_TOKEN=&lt;paste the token&gt;
              </pre>
            </div>
            <ModalFooter cancelLabel="Done, I've copied it" onCancel={() => setRevealed(null)} />
          </div>
        )}
      </Modal>

      <ConfirmModal
        confirmLabel="Revoke"
        dangerous
        message={`Anything using "${revoking?.name}" stops working right away. This cannot be undone.`}
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
