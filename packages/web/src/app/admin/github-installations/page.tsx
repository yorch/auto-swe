'use client';

import { useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable } from '@/components/ui/DataTable';
import { DocLink } from '@/components/ui/DocLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { useOrganizationDirectory } from '@/hooks/useAdmin';
import {
  type GithubInstallationRow,
  useCreateGithubInstallation,
  useDeleteGithubInstallation,
  useGithubInstallations,
  useInstallationLinkImpact,
  useUpdateGithubInstallation,
} from '@/hooks/useGithubInstallations';
import { errMsg } from '@/lib/errors';
import { HELP_LINKS } from '@/lib/helpLinks';
import { navLabel } from '@/lib/navigation';
import { plural } from '@/lib/utils';

function CreateInstallationModal({ onClose, open }: { onClose: () => void; open: boolean }) {
  const [installationId, setInstallationId] = useState('');
  const [accountLogin, setAccountLogin] = useState('');
  const [host, setHost] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateGithubInstallation();

  const idProblem =
    installationId.trim() !== '' && !/^\d+$/.test(installationId.trim())
      ? 'The installation ID is a number, like 12345678.'
      : undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (idProblem) {
      return;
    }
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
          error={idProblem}
          hint="The number at the end of the installation's settings URL on GitHub."
          id="gh-install-new-installation-id"
          inputMode="numeric"
          label="Installation ID"
          onChange={(e) => setInstallationId(e.target.value)}
          placeholder="12345678"
          value={installationId}
        />
        <Input
          hint="The organization or user the app is installed on. Shown here only."
          id="gh-install-new-account"
          label="Account"
          onChange={(e) => setAccountLogin(e.target.value)}
          placeholder="acme"
          value={accountLogin}
        />
        <Input
          hint="Leave empty for the instance's own host. Cannot be changed later."
          id="gh-install-new-host"
          label="Host"
          onChange={(e) => setHost(e.target.value)}
          placeholder="ghe.example.com"
          value={host}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          disabled={!installationId.trim() || !accountLogin.trim() || idProblem !== undefined}
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
  const [organizationId, setOrganizationId] = useState(installation?.organizationId ?? '');
  const organizations = useOrganizationDirectory();
  const impact = useInstallationLinkImpact(installation?.id, organizationId);
  const [confirmLink, setConfirmLink] = useState(false);
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
    if (organizationId !== (target.organizationId ?? '')) {
      setConfirmLink(true);
      return;
    }
    await save();
  }
  async function save() {
    setError(null);
    try {
      await update.mutateAsync({
        body: {
          accountLogin: accountLogin.trim(),
          isActive: isActive === 'true',
          organizationId: organizationId || null,
        },
        id: target.id,
      });
      onClose();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <Modal onClose={onClose} open title={`Edit ${installation.accountLogin}`}>
      <ConfirmModal
        confirmLabel="Change organization"
        message={`${organizationId ? (impact.data?.outsideOrganizationConnectionCount ?? 0) : 0} repositories used by teams outside the selected organization already use this installation. Existing repositories keep working. New imports are restricted to the selected organization; unlinking makes the installation available to every organization.`}
        onClose={() => setConfirmLink(false)}
        onConfirm={save}
        open={confirmLink}
        title="Change installation organization"
      />
      <form className="space-y-4" onSubmit={submit}>
        <Select
          label="Organization"
          onChange={setOrganizationId}
          options={[
            { label: 'Unlinked (all organizations)', value: '' },
            ...(organizations.data ?? []).map((org) => ({ label: org.name, value: org.id })),
          ]}
          value={organizationId}
        />
        {impact.isError && (
          <Alert>Could not calculate the affected repositories. Retry before linking.</Alert>
        )}
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
            { label: 'Active', value: 'true' },
            { label: 'Retired', value: 'false' },
          ]}
          value={isActive}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          disabled={Boolean(
            organizationId && organizationId !== (target.organizationId ?? '') && !impact.isSuccess
          )}
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
        help={
          <p>
            The app&apos;s own credentials are instance-wide and live on the GitHub integration
            page; this is one row per GitHub organization the deployment reaches, on the
            instance&apos;s own host or on another host that has its own credentials. A repository
            with no installation uses the one configured there.
          </p>
        }
        learnMore={{ ...HELP_LINKS.githubAppSetup, label: 'GitHub App setup guide' }}
        subtitle="Where the GitHub App is installed."
        title={navLabel('/admin/github-installations')}
      />

      <Card className="p-4 sm:p-6">
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="GitHub installations"
          onRetry={() => void refetch()}
          rows={3}
        >
          {!installations || installations.length === 0 ? (
            <EmptyState
              action={
                <Button onClick={() => setNewOpen(true)} size="sm">
                  Add installation
                </Button>
              }
              hint={
                <>
                  A single-organization deployment does not need one. Add these only to reach
                  repositories in more than one GitHub organization.{' '}
                  <DocLink label="GitHub App setup guide" slug={HELP_LINKS.githubAppSetup.slug} />
                </>
              }
              icon="github"
              title="No installations recorded"
            />
          ) : (
            <div className="-mx-4">
              <DataTable
                actions={(i) => {
                  const repos = i._count?.connections ?? 0;
                  return (
                    <>
                      <Button onClick={() => setEditTarget(i)} size="sm" variant="secondary">
                        Edit
                      </Button>
                      <ActionMenu
                        items={[
                          {
                            disabled: repos > 0,
                            icon: 'trash',
                            id: 'delete',
                            label: 'Delete',
                            onAction: () => setDeleteTarget(i),
                            tone: 'danger',
                          },
                        ]}
                        label={`More actions for ${i.accountLogin}`}
                      />
                    </>
                  );
                }}
                className="max-sm:px-4"
                columns={[
                  {
                    cell: (i) => <span className="font-mono text-sm">{i.accountLogin}</span>,
                    header: 'Account',
                    id: 'account',
                    primary: true,
                    secondary: (i) =>
                      (i._count?.connections ?? 0) > 0 ? (
                        <span>
                          Cannot be deleted while {plural(i._count?.connections ?? 0, 'repository')}{' '}
                          use it
                        </span>
                      ) : null,
                  },
                  {
                    cell: (i) =>
                      i.host ? (
                        <span className="font-mono text-xs text-paper-300">{i.host}</span>
                      ) : (
                        <span className="text-xs text-paper-500">Instance host</span>
                      ),
                    header: 'Host',
                    id: 'host',
                  },
                  {
                    cell: (i) => (
                      <span className="font-mono text-xs text-paper-300">{i.installationId}</span>
                    ),
                    header: 'Installation ID',
                    id: 'installationId',
                  },
                  {
                    cell: (i) => (
                      <span>
                        {i.organizationId ?? 'Unlinked'}
                        {i.organizationId &&
                          ` · ${i.outsideOrganizationConnectionCount ?? 0} outside-org repositories`}
                      </span>
                    ),
                    header: 'Organization',
                    id: 'organization',
                  },
                  {
                    align: 'right',
                    cell: (i) => (
                      <span className="text-xs text-paper-300 tabular-nums">
                        {i._count?.connections ?? 0}
                      </span>
                    ),
                    header: 'Repositories',
                    id: 'repositories',
                  },
                  {
                    cell: (i) => (
                      <Badge dot tone={i.isActive ? 'success' : 'muted'}>
                        {i.isActive ? 'Active' : 'Retired'}
                      </Badge>
                    ),
                    header: 'Status',
                    id: 'status',
                  },
                ]}
                density="compact"
                getRowId={(i) => i.id}
                revealActions={false}
                rows={installations}
              />
            </div>
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
