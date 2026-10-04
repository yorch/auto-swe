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
          <label className="flex items-center gap-2 text-xs text-paper-300">
            <input
              checked={clearToken}
              onChange={(e) => setClearToken(e.target.checked)}
              type="checkbox"
            />
            Remove the token
          </label>
        )}
        <Input
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
          <label className="flex items-center gap-2 text-xs text-paper-300">
            <input
              checked={clearApp}
              onChange={(e) => setClearApp(e.target.checked)}
              type="checkbox"
            />
            Remove the GitHub App
          </label>
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
    refetch,
    isLoading,
  } = useGithubHostCredentials();
  const remove = useDeleteGithubHostCredential();
  // `false` is closed, `null` is the add form, a row is the edit form.
  const [modal, setModal] = useState<GithubHostCredentialRow | null | false>(false);
  const [deleteTarget, setDeleteTarget] = useState<GithubHostCredentialRow | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Other GitHub hosts">Per-host credentials</CardTitle>
      </CardHeader>
      <p className="mb-4 text-xs text-paper-500">
        The token and App above belong to the instance&apos;s own host and are never sent anywhere
        else. A repository on another approved host is reached with that host&apos;s credentials
        recorded here; a host with none is reachable only with a user&apos;s own saved token.
      </p>
      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="Host credentials"
        onRetry={() => void refetch()}
      >
        {!credentials || credentials.length === 0 ? (
          <EmptyState className="py-4" title="No per-host credentials." />
        ) : (
          <Table>
            <THead>
              <Th variant="compact">Host</Th>
              <Th variant="compact">Credentials</Th>
              <Th variant="compact" />
            </THead>
            <tbody>
              {credentials.map((c) => (
                <TRow key={c.id}>
                  <Td className="py-2 pr-4 font-mono text-xs text-paper-100">{c.host}</Td>
                  <Td className="py-2 pr-4 font-mono text-[11px] text-paper-300">{summary(c)}</Td>
                  <Td className="py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <Button onClick={() => setModal(c)} size="sm" variant="secondary">
                        Edit
                      </Button>
                      <Button onClick={() => setDeleteTarget(c)} size="sm" variant="danger">
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
          Add host credentials
        </Button>
      </div>

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
    </Card>
  );
}
