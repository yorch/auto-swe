'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type GithubInstallationRow,
  useCreateGithubInstallation,
  useDeleteGithubInstallation,
  useGithubInstallations,
  useUpdateGithubInstallation,
} from '@/hooks/useGithubInstallations';
import { errMsg } from '@/lib/errors';

function CreateInstallationModal({ onClose, open }: { onClose: () => void; open: boolean }) {
  const [installationId, setInstallationId] = useState('');
  const [accountLogin, setAccountLogin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateGithubInstallation();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({
        accountLogin: accountLogin.trim(),
        installationId: installationId.trim(),
      });
      setInstallationId('');
      setAccountLogin('');
      onClose();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <Modal onClose={onClose} open={open} title="Add GitHub installation">
      <form className="space-y-4" onSubmit={submit}>
        <Input
          hint="From the installation's settings URL on GitHub: github.com/organizations/<org>/settings/installations/<id>"
          id="gh-install-new-installation-id"
          label="Installation ID"
          onChange={(e) => setInstallationId(e.target.value)}
          placeholder="12345678"
          value={installationId}
        />
        <Input
          hint="The organization or user the app is installed on. Shown here only — GitHub remains authoritative."
          id="gh-install-new-account"
          label="Account"
          onChange={(e) => setAccountLogin(e.target.value)}
          placeholder="acme"
          value={accountLogin}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          disabled={!installationId.trim() || !accountLogin.trim()}
          isPending={create.isPending}
          onCancel={onClose}
          pendingLabel="Adding…"
          submitLabel="Add installation"
        />
      </form>
    </Modal>
  );
}

function EditInstallationModal({
  installation,
  onClose,
}: {
  installation: GithubInstallationRow | null;
  onClose: () => void;
}) {
  const [accountLogin, setAccountLogin] = useState(installation?.accountLogin ?? '');
  const [isActive, setIsActive] = useState(installation?.isActive ? 'true' : 'false');
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateGithubInstallation();

  if (!installation) {
    return null;
  }
  // Bound after the guard, so the closure below closes over a value the
  // compiler has already narrowed rather than asserting non-null inside it.
  const target = installation;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update.mutateAsync({
        body: { accountLogin: accountLogin.trim(), isActive: isActive === 'true' },
        id: target.id,
      });
      onClose();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <Modal onClose={onClose} open title={`Edit installation ${installation.installationId}`}>
      <form className="space-y-4" onSubmit={submit}>
        <Input
          id="gh-install-edit-account"
          label="Account"
          onChange={(e) => setAccountLogin(e.target.value)}
          value={accountLogin}
        />
        <Select
          hint="Retiring stops NEW runs against the repositories pointing here. Work already in flight keeps cloning, pushing and reading CI through it, and nothing is disconnected on GitHub."
          id="gh-install-edit-status"
          label="Status"
          onChange={(e) => setIsActive(e.target.value)}
          value={isActive}
        >
          <option value="true">In use</option>
          <option value="false">Retired</option>
        </Select>
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          isPending={update.isPending}
          onCancel={onClose}
          pendingLabel="Saving…"
          submitLabel="Save changes"
        />
      </form>
    </Modal>
  );
}

export default function StudioGithubInstallationsPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<GithubInstallationRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GithubInstallationRow | null>(null);
  const { data: installations, isLoading, isError, error: loadError } = useGithubInstallations();
  const remove = useDeleteGithubInstallation();

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            Add installation
          </Button>
        }
        chapter="§ Studio"
        subtitle={
          <>
            Where the GitHub App is installed. The app&apos;s own credentials are instance-wide and
            live on the GitHub integration page; this is one row per GitHub organization the
            deployment reaches. A repository with no installation uses the one configured there.
          </>
        }
        title="GitHub installations"
      />

      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="GitHub installations"
      >
        <Card>
          <CardHeader>
            <CardTitle>Installations</CardTitle>
          </CardHeader>
          {!installations || installations.length === 0 ? (
            <EmptyState
              className="py-4"
              hint="A single-organization deployment does not need one — add these only to reach repositories in more than one GitHub organization."
              title="No installations recorded."
            />
          ) : (
            <Table>
              <THead>
                <Th variant="compact">Account</Th>
                <Th variant="compact">Installation ID</Th>
                <Th variant="compact">Repositories</Th>
                <Th variant="compact">Status</Th>
                <Th variant="compact" />
              </THead>
              <tbody>
                {installations.map((i) => (
                  <TRow key={i.id}>
                    <Td className="py-2 pr-4 font-mono text-xs text-paper-100">{i.accountLogin}</Td>
                    <Td className="py-2 pr-4 font-mono text-[11px] text-paper-300">
                      {i.installationId}
                    </Td>
                    <Td className="py-2 pr-4 text-xs text-paper-300">
                      {i._count?.connections ?? 0}
                    </Td>
                    <Td className="py-2 pr-4">
                      <Badge dot tone={i.isActive ? 'moss' : 'muted'} variant="text">
                        {i.isActive ? 'In use' : 'Retired'}
                      </Badge>
                    </Td>
                    <Td className="py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <Button onClick={() => setEditTarget(i)} size="sm" variant="secondary">
                          Edit
                        </Button>
                        <Button onClick={() => setDeleteTarget(i)} size="sm" variant="danger">
                          Delete
                        </Button>
                      </div>
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </QueryBoundary>

      {/*
        The form modals are keyed. Returning null does not unmount a component,
        so without a key its `error` state survives a close and reopen, or a
        switch to a different row. ConfirmModal clears its own error on close.
      */}
      <CreateInstallationModal
        key={newOpen ? 'create-open' : 'create-closed'}
        onClose={() => setNewOpen(false)}
        open={newOpen}
      />
      <EditInstallationModal
        installation={editTarget}
        key={editTarget?.id}
        onClose={() => setEditTarget(null)}
      />
      {/* The API refuses while repositories still point at an installation and
          names them; ConfirmModal shows that rejection inline. */}
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message="Repositories pointing at this installation must be repointed first. Deleting does not uninstall the app on GitHub."
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await remove.mutateAsync(deleteTarget.id);
          }
        }}
        open={deleteTarget !== null}
        pendingLabel="Deleting…"
        title={`Delete installation ${deleteTarget?.installationId ?? ''}?`}
      />
    </div>
  );
}
