'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import {
  type PatCreated,
  useCreatePat,
  usePersonalAccessTokens,
  useRevokePat,
} from '@/hooks/useWorkflows';
import { errMsg } from '@/lib/errors';
import { formatRelativeTime } from '@/lib/utils';

export function AccessTokensSection() {
  const { data: tokens, isLoading } = usePersonalAccessTokens();
  const create = useCreatePat();
  const revoke = useRevokePat();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<string>('90');
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<PatCreated | null>(null);
  const [copied, setCopied] = useState(false);

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

  async function handleCopy() {
    if (!revealed) {
      return;
    }
    try {
      await navigator.clipboard.writeText(revealed.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — user can select manually
    }
  }

  function handleRevoke(id: string, label: string) {
    if (!window.confirm(`Revoke "${label}"? Anything using this token will stop working.`)) {
      return;
    }
    revoke.mutate(id);
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle eyebrow="for the auto-swe CLI">Personal access tokens</CardTitle>
          <Button onClick={() => setCreating(true)} size="sm" variant="primary">
            + New token
          </Button>
        </CardHeader>

        {isLoading ? (
          <p className="text-xs text-paper-500">Loading…</p>
        ) : (tokens ?? []).length === 0 ? (
          <p className="text-xs text-paper-500">
            No tokens yet. Create one to authenticate the <code>auto-swe</code> CLI via
            <code className="ml-1 text-paper-300">AUTO_SWE_TOKEN</code>.
          </p>
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
                        <span className="font-mono text-[10px] uppercase tracking-wider text-brick-400">
                          revoked
                        </span>
                      )}
                      {!revoked && expired && (
                        <span className="font-mono text-[10px] uppercase tracking-wider text-amber-400">
                          expired
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 font-mono text-[10px] uppercase tracking-wider text-paper-500">
                      <span>Created {formatRelativeTime(t.createdAt)}</span>
                      {t.lastUsedAt && <span>· last used {formatRelativeTime(t.lastUsedAt)}</span>}
                      {t.expiresAt && <span>· expires {formatRelativeTime(t.expiresAt)}</span>}
                    </div>
                  </div>
                  {!revoked && (
                    <Button onClick={() => handleRevoke(t.id, t.name)} size="sm" variant="danger">
                      Revoke
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Modal
        eyebrow="§ New personal access token"
        onClose={() => setCreating(false)}
        open={creating}
        subtitle="Tokens authenticate the auto-swe CLI and API. The plaintext value is shown once and never stored — copy it before closing the next dialog."
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
          {error && (
            <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">{error}</p>
          )}
          <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
            <Button onClick={() => setCreating(false)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={create.isPending} type="submit" variant="primary">
              {create.isPending ? 'Creating…' : 'Create token'}
            </Button>
          </div>
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
            <div className="rounded-sm border border-ember-400/60 bg-ember-400/5 p-4">
              <code className="block break-all font-mono text-sm text-ember-200">
                {revealed.token}
              </code>
            </div>
            <Button onClick={handleCopy} size="sm" variant="secondary">
              {copied ? '✓ Copied' : 'Copy to clipboard'}
            </Button>
            <div className="flex items-center justify-end border-t border-ink-600 pt-4">
              <Button onClick={() => setRevealed(null)} type="button" variant="ghost">
                I have it
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
