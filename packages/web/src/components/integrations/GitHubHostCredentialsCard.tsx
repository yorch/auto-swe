'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { Textarea } from '@/components/ui/Textarea';
import {
  type GithubHostCredentialRow,
  type UpdateGithubHostCredentialBody,
  useCreateGithubHostCredential,
  useDeleteGithubHostCredential,
  useGithubHostCredentials,
  useUpdateGithubHostCredential,
} from '@/hooks/useGithubHostCredentials';
import { errMsg } from '@/lib/errors';
import { IntegrationCard } from './IntegrationCard';

/**
 * Adds a host's credentials, or — given `edit` — changes the ones it has. When
 * editing, a secret field left empty is unchanged; "Clear" removes it.
 */
function CredentialModal({
  edit,
  onClose,
}: {
  edit: GithubHostCredentialRow | null;
  onClose: () => void;
}) {
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [appId, setAppId] = useState(edit?.appId ?? '');
  const [appPrivateKey, setAppPrivateKey] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [clearApp, setClearApp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateGithubHostCredential();
  const update = useUpdateGithubHostCredential();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (edit) {
        const body: UpdateGithubHostCredentialBody = {};
        if (clearToken) {
          body.token = null;
        } else if (token) {
          body.token = token;
        }
        if (clearApp) {
          body.appId = null;
          body.appPrivateKey = null;
        } else {
          if (appId.trim() !== (edit.appId ?? '')) {
            body.appId = appId.trim();
          }
          if (appPrivateKey) {
            body.appPrivateKey = appPrivateKey;
          }
        }
        await update.mutateAsync({ body, id: edit.id });
      } else {
        await create.mutateAsync({
          host: host.trim().toLowerCase(),
          ...(token && { token }),
          ...(appId.trim() && { appId: appId.trim() }),
          ...(appPrivateKey && { appPrivateKey }),
        });
      }
      onClose();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  const empty = !(token || appId.trim() || appPrivateKey || clearToken || clearApp);

  return (
    <Modal
      onClose={onClose}
      open
      title={edit ? `Credentials for ${edit.host}` : 'Add host credentials'}
    >
      <form className="space-y-4" onSubmit={submit}>
        {!edit && (
          <Input
            className="font-mono"
            hint="Any approved GitHub host that is not the instance's own: GitHub Enterprise Server (ghe.corp or ghe.corp:8443), a data-residency tenant (acme.ghe.com), or github.com. It must be listed in Additional repository hosts."
            id="gh-host-cred-host"
            label="Host"
            onChange={(e) => setHost(e.target.value)}
            placeholder="ghe.example.com"
            value={host}
          />
        )}
        <Input
          autoComplete="off"
          className="font-mono"
          hint={
            edit?.hasToken
              ? `Set (••••${edit.tokenLastFour}). Leave empty to keep it.`
              : 'A personal access token with access to the repositories on this host.'
          }
          id="gh-host-cred-token"
          label="Personal access token"
          onChange={(e) => setToken(e.target.value)}
          type="password"
          value={token}
        />
        {edit?.hasToken && (
          <Checkbox
            checked={clearToken}
            label="Remove the token"
            onChange={(e) => setClearToken(e.target.checked)}
          />
        )}
        <Input
          className="font-mono"
          hint="The numeric id of a GitHub App registered on this host. Which installation a repository uses is chosen on the GitHub installations page."
          id="gh-host-cred-app-id"
          label="GitHub App ID"
          onChange={(e) => setAppId(e.target.value)}
          placeholder="12345"
          value={appId}
        />
        <Textarea
          autoComplete="off"
          compact
          hint={
            edit?.hasAppPrivateKey
              ? `Set (…${edit.appPrivateKeyLastFour}). Leave empty to keep it.`
              : "The App's PEM private key. It is stored encrypted and never shown again."
          }
          id="gh-host-cred-app-key"
          label="GitHub App private key"
          onChange={(e) => setAppPrivateKey(e.target.value)}
          rows={4}
          value={appPrivateKey}
        />
        {edit?.appId && (
          <Checkbox
            checked={clearApp}
            label="Remove the GitHub App"
            onChange={(e) => setClearApp(e.target.checked)}
          />
        )}
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          disabled={empty || (!edit && !host.trim())}
          isPending={create.isPending || update.isPending}
          onCancel={onClose}
          pendingLabel="Saving…"
          submitLabel={edit ? 'Save changes' : 'Add credentials'}
        />
      </form>
    </Modal>
  );
}

function summary(c: GithubHostCredentialRow): string {
  const parts: string[] = [];
  if (c.hasToken) {
    parts.push(`PAT ••••${c.tokenLastFour}`);
  }
  if (c.appId) {
    parts.push(`App ${c.appId}`);
  }
  return parts.join(' · ');
}

/**
 * Platform credentials for GitHub hosts other than the instance's own.
 * Rendered outside the tab's form: it saves on its own, not with "Save changes".
 */
export function GitHubHostCredentialsCard() {
  const {
    data: credentials,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useGithubHostCredentials();
  const remove = useDeleteGithubHostCredential();
  // `false` is closed, `null` is the add form, a row is the edit form.
  const [modal, setModal] = useState<GithubHostCredentialRow | null | false>(false);
  const [deleteTarget, setDeleteTarget] = useState<GithubHostCredentialRow | null>(null);

  const addButton = (
    <Button onClick={() => setModal(null)} size="sm" type="button">
      <Icon name="plus" size={14} />
      Add host credentials
    </Button>
  );

  return (
    <IntegrationCard
      description="The token and App above belong to the instance's own host and are never sent anywhere else. A repository on another approved host is reached with that host's credentials recorded here; a host with none is reachable only with a user's own saved token."
      eyebrow="Other GitHub hosts"
      headerAction={credentials && credentials.length > 0 ? addButton : undefined}
      title="Per-host credentials"
    >
      <QueryBoundary
        compact
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="Host credentials"
        onRetry={() => void refetch()}
      >
        {!credentials || credentials.length === 0 ? (
          <EmptyState
            action={addButton}
            bordered
            className="py-6"
            hint="Only needed to reach repositories on a second GitHub host."
            icon="key"
            title="No per-host credentials"
          />
        ) : (
          <Table>
            <THead>
              <Th className="pl-0" variant="plain">
                Host
              </Th>
              <Th variant="plain">Credentials</Th>
              <Th className="pr-0" variant="plain">
                <span className="sr-only">Actions</span>
              </Th>
            </THead>
            <tbody>
              {credentials.map((c) => (
                <TRow key={c.id}>
                  <Td className="py-2.5 pr-4 font-mono text-[13px] text-paper-100">{c.host}</Td>
                  <Td className="px-4 py-2.5 font-mono text-xs text-paper-300">{summary(c)}</Td>
                  <Td className="py-2.5 pl-4 text-right">
                    <div className="flex justify-end gap-1">
                      <Button onClick={() => setModal(c)} size="sm" variant="secondary">
                        Edit
                      </Button>
                      <Button
                        aria-label={`Delete the credentials for ${c.host}`}
                        onClick={() => setDeleteTarget(c)}
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
        <CredentialModal edit={modal} key={modal?.id ?? 'new'} onClose={() => setModal(false)} />
      )}
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message="Runs on this host's repositories fail until a user saves their own token or the credentials are added again."
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await remove.mutateAsync(deleteTarget.id);
          }
        }}
        open={deleteTarget !== null}
        pendingLabel="Deleting…"
        title={`Delete the credentials for ${deleteTarget?.host ?? ''}?`}
      />
    </IntegrationCard>
  );
}
