'use client';

import { useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
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
  const [host, setHost] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateGithubInstallation();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({
        accountLogin: accountLogin.trim(),
        ...(host.trim() && { host: host.trim().toLowerCase() }),
        installationId: installationId.trim(),
      });
      setInstallationId('');
      setAccountLogin('');
      setHost('');
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
        <Input
          hint="Leave empty for the instance's own GitHub host. For another host, enter it as it appears under Per-host credentials — the same installation id can exist on two hosts. It cannot be changed later."
          id="gh-install-new-host"
          label="Host"
          onChange={(e) => setHost(e.target.value)}
          placeholder="ghe.example.com"
          value={host}
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
          onChange={(v) => setIsActive(v)}
          options={[
            { label: 'In use', value: 'true' },
            { label: 'Retired', value: 'false' },
          ]}
          value={isActive}
        />
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
  const {
    data: installations,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useGithubInstallations();
  const remove = useDeleteGithubInstallation();

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            <Icon name="plus" size={14} />
            Add installation
          </Button>
        }
        subtitle={
          <>
            Where the GitHub App is installed. The app&apos;s own credentials are instance-wide and
            live on the GitHub integration page; this is one row per GitHub organization the
            deployment reaches, on the instance&apos;s own host or on another host that has its own
            credentials. A repository with no installation uses the one configured there.
          </>
        }
        title="GitHub installations"
      />

      <Card className="p-4 sm:p-6">
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={false}
          label="GitHub installations"
          onRetry={() => void refetch()}
        >
          {isLoading ? (
            <SkeletonRows rows={3} />
          ) : !installations || installations.length === 0 ? (
            <EmptyState
              action={
                <Button onClick={() => setNewOpen(true)} size="sm">
                  Add installation
                </Button>
              }
              hint="A single-organization deployment does not need one. Add these only to reach repositories in more than one GitHub organization."
              icon="github"
              title="No installations recorded"
            />
          ) : (
            <Table stacked>
              <THead>
                <Th className="pl-0" variant="plain">
                  Account
                </Th>
                <Th variant="plain">Host</Th>
                <Th variant="plain">Installation ID</Th>
                <Th align="right" variant="plain">
                  Repositories
                </Th>
                <Th variant="plain">Status</Th>
                <Th className="pr-0" variant="plain">
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <tbody>
                {installations.map((i) => {
                  const repos = i._count?.connections ?? 0;
                  return (
                    <TRow key={i.id}>
                      <Td
                        className="py-2.5 pr-4 font-mono text-[13px] font-medium text-paper-100"
                        primary
                      >
                        {i.accountLogin}
                      </Td>
                      <Td className="px-4 py-2.5 text-xs text-paper-300" label="Host">
                        {i.host ? (
                          <span className="font-mono">{i.host}</span>
                        ) : (
                          <span className="text-paper-500">Instance host</span>
                        )}
                      </Td>
                      <Td
                        className="px-4 py-2.5 font-mono text-xs text-paper-300"
                        label="Installation ID"
                      >
                        {i.installationId}
                      </Td>
                      <Td
                        align="right"
                        className="px-4 py-2.5 text-xs text-paper-300 tabular-nums"
                        label="Repositories"
                      >
                        {repos}
                      </Td>
                      <Td className="px-4 py-2.5" label="Status">
                        <Badge dot tone={i.isActive ? 'moss' : 'muted'}>
                          {i.isActive ? 'In use' : 'Retired'}
                        </Badge>
                      </Td>
                      <Td className="py-2.5 pl-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button onClick={() => setEditTarget(i)} size="sm" variant="secondary">
                            Edit
                          </Button>
                          <ActionMenu
                            items={[
                              {
                                disabled: repos > 0,
                                icon: 'trash',
                                id: 'delete',
                                label:
                                  repos > 0
                                    ? `In use by ${repos} ${repos === 1 ? 'repository' : 'repositories'}`
                                    : 'Delete',
                                onAction: () => setDeleteTarget(i),
                                tone: 'danger',
                              },
                            ]}
                            label={`More actions for ${i.accountLogin}`}
                          />
                        </div>
                      </Td>
                    </TRow>
                  );
                })}
              </tbody>
            </Table>
          )}
        </QueryBoundary>
      </Card>

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
