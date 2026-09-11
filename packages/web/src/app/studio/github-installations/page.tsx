'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
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

  async function submit() {
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
      <div className="space-y-4">
        <FieldWrapper
          hint="From the installation's settings URL on GitHub: github.com/organizations/<org>/settings/installations/<id>"
          label="Installation ID"
        >
          <Input
            onChange={(e) => setInstallationId(e.target.value)}
            placeholder="12345678"
            value={installationId}
          />
        </FieldWrapper>
        <FieldWrapper
          hint="The organization or user the app is installed on. Shown here only — GitHub remains authoritative."
          label="Account"
        >
          <Input
            onChange={(e) => setAccountLogin(e.target.value)}
            placeholder="acme"
            value={accountLogin}
          />
        </FieldWrapper>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button
            disabled={!installationId.trim() || !accountLogin.trim() || create.isPending}
            onClick={submit}
            variant="primary"
          >
            {create.isPending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </div>
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

  async function submit() {
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
      <div className="space-y-4">
        <FieldWrapper label="Account">
          <Input onChange={(e) => setAccountLogin(e.target.value)} value={accountLogin} />
        </FieldWrapper>
        <FieldWrapper
          hint="Bookkeeping only. Nothing reads this: a repository pointing at an installation marked retired still uses it, and marking one retired does not disconnect anything on GitHub or here."
          label="Operator note"
        >
          <Select onChange={(e) => setIsActive(e.target.value)} value={isActive}>
            <option value="true">In use</option>
            <option value="false">Retired</option>
          </Select>
        </FieldWrapper>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button disabled={update.isPending} onClick={submit} variant="primary">
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteInstallationModal({
  installation,
  onClose,
}: {
  installation: GithubInstallationRow | null;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const remove = useDeleteGithubInstallation();

  if (!installation) {
    return null;
  }
  const target = installation;

  async function submit() {
    setError(null);
    try {
      await remove.mutateAsync(target.id);
      onClose();
    } catch (err) {
      // The API refuses while repositories still point at it and names them,
      // which is more useful than a foreign-key error.
      setError(errMsg(err));
    }
  }

  return (
    <Modal onClose={onClose} open title={`Delete installation ${installation.installationId}?`}>
      <div className="space-y-4">
        <p className="text-sm text-paper-300">
          Repositories pointing at this installation must be repointed first. Deleting does not
          uninstall the app on GitHub.
        </p>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button disabled={remove.isPending} onClick={submit} variant="danger">
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function StudioGithubInstallationsPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<GithubInstallationRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GithubInstallationRow | null>(null);
  const { data: installations, isLoading, isError, error: loadError } = useGithubInstallations();

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            + Add Installation
          </Button>
        }
        subtitle={
          <>
            Where the GitHub App is installed. The app&apos;s own credentials are instance-wide and
            live on the GitHub integration page; this is one row per GitHub organization the
            deployment reaches. A repository with no installation uses the one configured there.
          </>
        }
        title="GitHub Installations"
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
            <div className="py-4 text-center text-sm text-paper-400">
              No installations recorded. A single-organization deployment does not need one — add
              these only to reach repositories in more than one GitHub organization.
            </div>
          ) : (
            <Table>
              <THead>
                <Th variant="compact">Account</Th>
                <Th variant="compact">Installation ID</Th>
                <Th variant="compact">Repositories</Th>
                <Th variant="compact">Note</Th>
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
                    <Td className="py-2 pr-4 text-xs text-paper-300">
                      {i.isActive ? 'In use' : 'Retired'}
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
        Every modal is keyed. Returning null does not unmount a component, so
        without a key its `error` state survives: read the 409 naming the
        repositories that still use one installation, cancel, open Delete on a
        different one, and the old error is still sitting under the new title.
        The create modal keeps its error across close and reopen the same way.
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
      <DeleteInstallationModal
        installation={deleteTarget}
        key={deleteTarget?.id}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
