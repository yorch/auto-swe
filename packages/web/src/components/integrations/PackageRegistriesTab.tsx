'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type PackageRegistryBody,
  type PackageRegistryRow,
  useCreatePackageRegistry,
  useDeletePackageRegistry,
  usePackageRegistries,
  useUpdatePackageRegistry,
} from '@/hooks/usePackageRegistries';
import { errMsg } from '@/lib/errors';

const ECOSYSTEM_LABEL: Record<PackageRegistryBody['ecosystem'], string> = {
  go: 'Go',
  npm: 'npm',
  pypi: 'PyPI',
};

/** A Go or PyPI registry takes no scopes; each says what it serves in place of them. */
const SCOPELESS_NOTE: Record<Exclude<PackageRegistryBody['ecosystem'], 'npm'>, string> = {
  go: 'A Go registry has no scopes: it serves every module for its team.',
  pypi: 'A PyPI registry has no scopes: it serves every package for its team. Its upstream URL is the simple index, e.g. https://pypi.org/simple.',
};

const EMPTY: PackageRegistryBody = {
  accessMode: 'lockfile',
  allowPrivateNetwork: false,
  authKind: 'bearer',
  ecosystem: 'npm',
  name: '',
  npmScopes: [],
  teamId: null,
  upstreamUrl: '',
};

function RegistryModal({
  initial,
  onClose,
  registry,
}: {
  initial: PackageRegistryBody;
  onClose: () => void;
  registry?: PackageRegistryRow;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const create = useCreatePackageRegistry();
  const update = useUpdatePackageRegistry(registry?.id ?? '');
  const busy = create.isPending || update.isPending;

  const submit = async () => {
    setError(null);
    const body = { ...form, token: form.token || undefined };
    try {
      if (registry) {
        // The ecosystem is immutable once created.
        const { ecosystem: _ecosystem, ...changes } = body;
        await update.mutateAsync(changes);
      } else {
        await create.mutateAsync(body);
      }
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Could not save the registry'));
    }
  };

  return (
    <Modal
      onClose={onClose}
      open
      title={registry ? `Edit ${registry.name}` : 'Add package registry'}
    >
      <div className="space-y-4">
        {error && <Alert variant="error">{error}</Alert>}
        {registry ? (
          <p className="text-sm text-paper-300">Ecosystem: {ECOSYSTEM_LABEL[form.ecosystem]}</p>
        ) : (
          <label className="block text-sm text-paper-300">
            Ecosystem{' '}
            <select
              className="rounded border border-ink-400 bg-ink-700 px-2 py-1"
              onChange={(e) => {
                const ecosystem = e.target.value as PackageRegistryBody['ecosystem'];
                setForm({
                  ...form,
                  ecosystem,
                  npmScopes: ecosystem === 'npm' ? form.npmScopes : [],
                });
              }}
              value={form.ecosystem}
            >
              <option value="npm">npm</option>
              <option value="go">Go</option>
              <option value="pypi">PyPI</option>
            </select>
          </label>
        )}
        <Input
          label="Name"
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
          value={form.name}
        />
        <Input
          hint="The upstream the proxy forwards to, e.g. https://registry.npmjs.org or an internal Artifactory."
          label="Upstream URL"
          onChange={(e) => setForm({ ...form, upstreamUrl: e.target.value })}
          placeholder={form.ecosystem === 'pypi' ? 'https://pypi.org/simple' : undefined}
          required
          value={form.upstreamUrl}
        />
        {form.ecosystem === 'npm' ? (
          <Input
            hint="Comma-separated, e.g. @acme,@acme-internal. Empty means the default registry for unscoped packages."
            label="npm scopes"
            onChange={(e) =>
              setForm({
                ...form,
                npmScopes: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            value={form.npmScopes.join(',')}
          />
        ) : (
          <p className="text-sm text-paper-400">{SCOPELESS_NOTE[form.ecosystem]}</p>
        )}
        <Input
          hint={
            registry
              ? 'Write-only. Leave blank to keep the stored credential.'
              : 'Bearer token, or user:password for basic auth.'
          }
          label={registry ? 'Token (rotate)' : 'Token'}
          onChange={(e) => setForm({ ...form, token: e.target.value })}
          type="password"
          value={form.token ?? ''}
        />
        <div className="flex gap-4">
          <label className="text-sm text-paper-300">
            Access mode{' '}
            <select
              className="rounded border border-ink-400 bg-ink-700 px-2 py-1"
              onChange={(e) =>
                setForm({ ...form, accessMode: e.target.value as 'lockfile' | 'open' })
              }
              value={form.accessMode}
            >
              <option value="lockfile">lockfile</option>
              <option value="open">open</option>
            </select>
          </label>
          <label className="text-sm text-paper-300">
            Auth{' '}
            <select
              className="rounded border border-ink-400 bg-ink-700 px-2 py-1"
              onChange={(e) => setForm({ ...form, authKind: e.target.value as 'bearer' | 'basic' })}
              value={form.authKind}
            >
              <option value="bearer">bearer</option>
              <option value="basic">basic</option>
            </select>
          </label>
        </div>
        <Checkbox
          checked={form.allowPrivateNetwork}
          label="Upstream is on a private network"
          onChange={(e) => setForm({ ...form, allowPrivateNetwork: e.target.checked })}
        />
        {registry && (
          <Checkbox
            checked={form.isActive ?? true}
            label="Active"
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
          />
        )}
      </div>
      <ModalFooter
        disabled={busy || !form.name || !form.upstreamUrl}
        isPending={busy}
        onCancel={onClose}
        onSubmit={() => void submit()}
        pendingLabel="Saving…"
        submitLabel="Save"
      />
    </Modal>
  );
}

const columns: DataTableColumn<PackageRegistryRow>[] = [
  {
    cell: (r) => r.name,
    header: 'Name',
    id: 'name',
    primary: true,
    secondary: (r) => r.upstreamUrl,
  },
  { cell: (r) => r.ecosystem, header: 'Ecosystem', id: 'ecosystem' },
  {
    cell: (r) => (r.npmScopes.length ? r.npmScopes.join(', ') : 'default'),
    header: 'Scopes',
    id: 'scopes',
  },
  { cell: (r) => r.accessMode, header: 'Mode', id: 'mode' },
  { cell: (r) => (r.teamId ? 'team' : 'all teams'), header: 'Scope', id: 'scope' },
  { cell: (r) => (r.hasToken ? `•••${r.tokenLastFour ?? ''}` : '—'), header: 'Token', id: 'token' },
  { cell: (r) => (r.isActive ? 'active' : 'disabled'), header: 'State', id: 'state' },
];

export function PackageRegistriesTab() {
  const query = usePackageRegistries();
  const del = useDeletePackageRegistry();
  const [modal, setModal] = useState<'create' | PackageRegistryRow | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-paper-400">
          npm, Go and PyPI registries workspaces install through the worker's registry proxy. The
          upstream credential stays in the worker; a workspace holds only its own proxy token.
        </p>
        <Button onClick={() => setModal('create')}>Add registry</Button>
      </div>
      <QueryBoundary
        error={query.error}
        isError={query.isError}
        isLoading={query.isLoading}
        label="package registries"
        onRetry={() => void query.refetch()}
      >
        {(query.data ?? []).length === 0 ? (
          <EmptyState hint="No package registries configured." title="No registries" />
        ) : (
          <DataTable
            columns={[
              ...columns,
              {
                cell: (r) => (
                  <span className="flex gap-2">
                    <button className="text-accent-400" onClick={() => setModal(r)} type="button">
                      Edit
                    </button>
                    <button
                      className="text-paper-400"
                      onClick={() => void del.mutateAsync(r.id)}
                      type="button"
                    >
                      Delete
                    </button>
                  </span>
                ),
                header: '',
                id: 'actions',
              },
            ]}
            getRowId={(r) => r.id}
            rows={query.data ?? []}
          />
        )}
      </QueryBoundary>
      {modal === 'create' && <RegistryModal initial={EMPTY} onClose={() => setModal(null)} />}
      {modal && modal !== 'create' && (
        <RegistryModal
          initial={{
            accessMode: modal.accessMode,
            allowPrivateNetwork: modal.allowPrivateNetwork,
            authKind: modal.authKind,
            ecosystem: modal.ecosystem,
            isActive: modal.isActive,
            name: modal.name,
            npmScopes: modal.npmScopes,
            teamId: modal.teamId,
            token: '',
            upstreamUrl: modal.upstreamUrl,
          }}
          onClose={() => setModal(null)}
          registry={modal}
        />
      )}
    </div>
  );
}
