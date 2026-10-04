'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type GithubWebhookSecretRow,
  useCreateGithubWebhookSecret,
  useDeleteGithubWebhookSecret,
  useGithubWebhookSecrets,
  useRotateGithubWebhookSecret,
} from '@/hooks/useGithubWebhookSecrets';
import { errMsg } from '@/lib/errors';

/** Adds a host's secret, or — given `rotate` — replaces the one it has. */
function SecretModal({
  onClose,
  rotate,
}: {
  onClose: () => void;
  rotate: GithubWebhookSecretRow | null;
}) {
  const [host, setHost] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateGithubWebhookSecret();
  const update = useRotateGithubWebhookSecret();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (rotate) {
        await update.mutateAsync({ id: rotate.id, secret });
      } else {
        await create.mutateAsync({ host: host.trim().toLowerCase(), secret });
      }
      onClose();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <Modal
      onClose={onClose}
      open
      title={rotate ? `Rotate secret for ${rotate.host}` : 'Add host webhook secret'}
    >
      <form className="space-y-4" onSubmit={submit}>
        {!rotate && (
          <Input
            hint="The GitHub Enterprise host as it appears in X-GitHub-Enterprise-Host, e.g. ghe.corp or ghe.corp:8443. It must be the GitHub integration's host or listed in Additional repository hosts."
            id="gh-host-secret-host"
            label="Host"
            onChange={(e) => setHost(e.target.value)}
            placeholder="ghe.example.com"
            value={host}
          />
        )}
        <Input
          autoComplete="off"
          hint="The secret configured on that host's webhooks. Deliveries naming this host are verified with it alone."
          id="gh-host-secret-secret"
          label="Webhook secret"
          onChange={(e) => setSecret(e.target.value)}
          type="password"
          value={secret}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          disabled={!secret || (!rotate && !host.trim())}
          isPending={create.isPending || update.isPending}
          onCancel={onClose}
          pendingLabel="Saving…"
          submitLabel={rotate ? 'Rotate secret' : 'Add secret'}
        />
      </form>
    </Modal>
  );
}

/**
 * Webhook secrets for GitHub Enterprise hosts other than the one the instance
 * secret above belongs to. Rendered outside the tab's form: it saves on its
 * own, not with "Save changes".
 */
export function GitHubHostSecretsCard() {
  const {
    data: secrets,
    error: loadError,
    isError,
    refetch,
    isLoading,
  } = useGithubWebhookSecrets();
  const remove = useDeleteGithubWebhookSecret();
  // `false` is closed, `null` is the add form, a row is the rotate form.
  const [modal, setModal] = useState<GithubWebhookSecretRow | null | false>(false);
  const [deleteTarget, setDeleteTarget] = useState<GithubWebhookSecretRow | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="GitHub Enterprise">Per-host webhook secrets</CardTitle>
      </CardHeader>
      <p className="mb-4 text-xs text-paper-500">
        A GitHub Enterprise Server host names itself in each delivery. When it has a secret here,
        its deliveries are verified with that secret instead of the one above. A host with none uses
        the one above, and github.com always does.
      </p>
      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="Host webhook secrets"
        onRetry={() => void refetch()}
      >
        {!secrets || secrets.length === 0 ? (
          <EmptyState className="py-4" title="No per-host secrets." />
        ) : (
          <Table>
            <THead>
              <Th variant="compact">Host</Th>
              <Th variant="compact">Secret</Th>
              <Th variant="compact" />
            </THead>
            <tbody>
              {secrets.map((s) => (
                <TRow key={s.id}>
                  <Td className="py-2 pr-4 font-mono text-xs text-paper-100">{s.host}</Td>
                  <Td className="py-2 pr-4 font-mono text-[11px] text-paper-300">
                    ••••{s.lastFour}
                  </Td>
                  <Td className="py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <Button onClick={() => setModal(s)} size="sm" variant="secondary">
                        Rotate
                      </Button>
                      <Button onClick={() => setDeleteTarget(s)} size="sm" variant="danger">
                        Delete
                      </Button>
                    </div>
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </QueryBoundary>
      <div className="mt-4 flex justify-end">
        <Button onClick={() => setModal(null)} size="sm" type="button" variant="secondary">
          Add host secret
        </Button>
      </div>

      {modal !== false && (
        <SecretModal key={modal?.id ?? 'new'} onClose={() => setModal(false)} rotate={modal} />
      )}
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message="Deliveries from this host will be verified with the instance secret again, and fail until that host's webhooks use it."
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await remove.mutateAsync(deleteTarget.id);
          }
        }}
        open={deleteTarget !== null}
        pendingLabel="Deleting…"
        title={`Delete the secret for ${deleteTarget?.host ?? ''}?`}
      />
    </Card>
  );
}
