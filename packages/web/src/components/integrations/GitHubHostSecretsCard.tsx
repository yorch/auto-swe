'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
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
import { IntegrationCard } from './IntegrationCard';

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
            className="font-mono"
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
          className="font-mono"
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
    isFetching,
    refetch,
    isLoading,
  } = useGithubWebhookSecrets();
  const remove = useDeleteGithubWebhookSecret();
  // `false` is closed, `null` is the add form, a row is the rotate form.
  const [modal, setModal] = useState<GithubWebhookSecretRow | null | false>(false);
  const [deleteTarget, setDeleteTarget] = useState<GithubWebhookSecretRow | null>(null);

  const addButton = (
    <Button onClick={() => setModal(null)} size="sm" type="button">
      <Icon name="plus" size={14} />
      Add host secret
    </Button>
  );

  return (
    <IntegrationCard
      description="A GitHub Enterprise Server host names itself in each delivery. When it has a secret here, its deliveries are verified with that secret instead of the one above. A host with none uses the one above, and github.com always does."
      eyebrow="Webhooks"
      headerAction={secrets && secrets.length > 0 ? addButton : undefined}
      title="Per-host webhook secrets"
    >
      <QueryBoundary
        compact
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="Host webhook secrets"
        onRetry={() => void refetch()}
      >
        {!secrets || secrets.length === 0 ? (
          <EmptyState
            action={addButton}
            bordered
            className="py-6"
            hint="Only needed when a second GitHub Enterprise host signs its webhooks with its own secret."
            icon="lock"
            title="No per-host secrets"
          />
        ) : (
          <Table>
            <THead>
              <Th className="pl-0" variant="plain">
                Host
              </Th>
              <Th variant="plain">Secret</Th>
              <Th className="pr-0" variant="plain">
                <span className="sr-only">Actions</span>
              </Th>
            </THead>
            <tbody>
              {secrets.map((s) => (
                <TRow key={s.id}>
                  <Td className="py-2.5 pr-4 font-mono text-[13px] text-paper-100">{s.host}</Td>
                  <Td className="px-4 py-2.5 font-mono text-xs text-paper-300">••••{s.lastFour}</Td>
                  <Td className="py-2.5 pl-4 text-right">
                    <div className="flex justify-end gap-1">
                      <Button onClick={() => setModal(s)} size="sm" variant="secondary">
                        Rotate
                      </Button>
                      <Button
                        aria-label={`Delete the secret for ${s.host}`}
                        onClick={() => setDeleteTarget(s)}
                        size="sm"
                        variant="ghost"
                      >
                        <Icon className="text-brick-400" name="trash" size={14} />
                      </Button>
                    </div>
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </QueryBoundary>

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
    </IntegrationCard>
  );
}
