'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type PatCreated,
  useCreatePat,
  usePersonalAccessTokens,
  useRevokePat,
} from '@/hooks/usePats';
import { errMsg } from '@/lib/errors';
import { formatRelativeTime } from '@/lib/utils';

/**
 * The API tokens section of the settings page, header included: the "New
 * token" action belongs in the section header, so the section owns it.
 */
export function AccessTokensSection({ number }: { number?: string }) {
  const { data: tokens, error: loadError, isError, isLoading } = usePersonalAccessTokens();
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

  return (
    <>
      <SectionHeader
        actions={
          <Button onClick={() => setCreating(true)} size="sm" variant="primary">
            New token
          </Button>
        }
        hint="for the auto-swe CLI"
        number={number}
        title="API tokens"
      />
      <Card variant="inset">
        <QueryBoundary
          compact
          error={loadError}
          isError={isError}
          isLoading={isLoading}
          label="tokens"
        >
          {(tokens ?? []).length === 0 ? (
            <EmptyState
              hint={
                <>
                  Create one to authenticate the CLI via
                  <code className="ml-1 text-paper-300">AUTO_SWE_TOKEN</code>.
                </>
              }
              title="No tokens yet"
            />
          ) : (
            <ul className="divide-y divide-ink-600">
              {(tokens ?? []).map((t) => {
                const revoked = !!t.revokedAt;
                const expired = !!t.expiresAt && new Date(t.expiresAt) < new Date();
                return (
                  <li className="flex items-center justify-between gap-4 py-3" key={t.id}>
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-3">
                        <span className="text-sm text-paper-100">{t.name}</span>
                        <code className="font-mono text-[10px] text-paper-500">{t.prefix}…</code>
                        {revoked && (
                          <Badge tone="brick" uppercase variant="text">
                            revoked
                          </Badge>
                        )}
                        {!revoked && expired && (
                          <Badge tone="amber" uppercase variant="text">
                            expired
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-3 font-mono text-[10px] uppercase tracking-wider text-paper-500">
                        <span>Created {formatRelativeTime(t.createdAt)}</span>
                        {t.lastUsedAt && (
                          <span>· last used {formatRelativeTime(t.lastUsedAt)}</span>
                        )}
                        {t.expiresAt && <span>· expires {formatRelativeTime(t.expiresAt)}</span>}
                      </div>
                    </div>
                    {!revoked && (
                      <Button
                        onClick={() => setRevoking({ id: t.id, name: t.name })}
                        size="sm"
                        variant="danger"
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </QueryBoundary>
      </Card>

      <Modal
        eyebrow="§ New personal access token"
        onClose={() => setCreating(false)}
        open={creating}
        subtitle="Tokens authenticate the CLI and API. The plaintext value is shown once and never stored — copy it before closing the next dialog."
        title="Mint a token"
      >
        <form className="space-y-5" onSubmit={handleCreate}>
          <Input
            autoFocus
            label="Name"
            onChange={(e) => setName(e.target.value)}
            placeholder="laptop / CI / curl-scratch"
            required
            value={name}
          />
          <Input
            hint="1–365. Leave blank for non-expiring."
            label="Expires in (days)"
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
        eyebrow="§ Copy now — shown only once"
        onClose={() => setRevealed(null)}
        open={revealed !== null}
        subtitle="This is the only time the full token will appear. Store it in your secret manager or as AUTO_SWE_TOKEN in your shell."
        title={revealed ? `Token "${revealed.name}" created` : ''}
      >
        {revealed && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-sm border border-ember-400/60 bg-ember-400/5 p-4">
              <code className="block min-w-0 flex-1 break-all font-mono text-sm text-ember-200">
                {revealed.token}
              </code>
              <CopyButton value={revealed.token} />
            </div>
            <ModalFooter cancelLabel="I have it" onCancel={() => setRevealed(null)} />
          </div>
        )}
      </Modal>

      <ConfirmModal
        confirmLabel="Revoke"
        dangerous
        message={`Revoke "${revoking?.name}"? Anything using this token will stop working.`}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking) {
            revoke.mutate(revoking.id);
          }
        }}
        open={revoking !== null}
        title="Revoke personal access token"
      />
    </>
  );
}
