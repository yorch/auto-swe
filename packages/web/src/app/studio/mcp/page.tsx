'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type McpConnectionRow,
  useCreateMcpConnection,
  useDeleteMcpConnection,
  useMcpConnections,
  useUpdateMcpConnection,
} from '@/hooks/useMcpConnections';
import { useTeams } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';
import { parseOptionalPositiveInt } from '@/lib/parseIntInput';

/**
 * Parse the two timeout text inputs shared by the create + edit forms. Returns
 * `{ error }` on an invalid entry, otherwise `null` (blank → clear/omit) or a
 * positive integer for each — the caller decides what null means for its route.
 */
function parseTimeoutInputs(form: {
  listTimeoutMs: string;
  callTimeoutMs: string;
}): { error: string } | { listTimeoutMs: number | null; callTimeoutMs: number | null } {
  const listTimeoutMs = parseOptionalPositiveInt(form.listTimeoutMs);
  const callTimeoutMs = parseOptionalPositiveInt(form.callTimeoutMs);
  if (listTimeoutMs === undefined || callTimeoutMs === undefined) {
    return {
      error: 'Timeouts must be positive whole numbers of milliseconds, or blank to use the default',
    };
  }
  return { callTimeoutMs, listTimeoutMs };
}

/** The list/call timeout grid, shared by the create + edit connection modals. */
function McpTimeoutFields({
  callTimeoutMs,
  idPrefix,
  listTimeoutMs,
  onChange,
}: {
  /** Distinguishes the create and edit forms' field ids, which can be mounted together. */
  idPrefix: string;
  listTimeoutMs: string;
  callTimeoutMs: string;
  onChange: (patch: { listTimeoutMs?: string; callTimeoutMs?: string }) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <Input
        id={`${idPrefix}-list-timeout`}
        label="List timeout (ms)"
        min={1}
        onChange={(e) => onChange({ listTimeoutMs: e.target.value })}
        placeholder="15000"
        step={1}
        type="number"
        value={listTimeoutMs}
      />
      <Input
        id={`${idPrefix}-call-timeout`}
        label="Call timeout (ms)"
        min={1}
        onChange={(e) => onChange({ callTimeoutMs: e.target.value })}
        placeholder="60000"
        step={1}
        type="number"
        value={callTimeoutMs}
      />
    </div>
  );
}

function CreateMcpConnectionModal({ onClose, open }: { onClose: () => void; open: boolean }) {
  const { data: teams } = useTeams();
  const create = useCreateMcpConnection();
  const initialForm = { callTimeoutMs: '', listTimeoutMs: '', name: '', teamId: '', url: '' };
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Blank → null → omit (loadMcpTools falls back to its own default).
    const parsed = parseTimeoutInputs(form);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    try {
      await create.mutateAsync({
        name: form.name,
        teamId: form.teamId,
        url: form.url,
        ...(parsed.listTimeoutMs !== null ? { listTimeoutMs: parsed.listTimeoutMs } : {}),
        ...(parsed.callTimeoutMs !== null ? { callTimeoutMs: parsed.callTimeoutMs } : {}),
      });
      onClose();
      setForm(initialForm);
    } catch (err) {
      setError(errMsg(err, 'Failed to create connection'));
    }
  }

  return (
    <Modal onClose={onClose} open={open} title="New MCP connection">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Input
          id="mcp-new-name"
          label="Name"
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="docs-server"
          required
          value={form.name}
        />
        <Input
          id="mcp-new-server-url"
          label="Server URL (http/https)"
          onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
          placeholder="https://mcp.example.com/mcp"
          required
          type="url"
          value={form.url}
        />
        <Combobox
          id="mcp-new-team"
          label="Team"
          onChange={(v) => setForm((f) => ({ ...f, teamId: v }))}
          options={(teams ?? []).map((t) => ({ label: t.name, value: t.id }))}
          placeholder="Select a team…"
          required
          value={form.teamId}
        />
        <McpTimeoutFields
          callTimeoutMs={form.callTimeoutMs}
          idPrefix="mcp-new"
          listTimeoutMs={form.listTimeoutMs}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          isPending={create.isPending}
          onCancel={onClose}
          pendingLabel="Creating…"
          submitLabel="Create connection"
        />
      </form>
    </Modal>
  );
}

function EditMcpConnectionModal({
  connection,
  onClose,
}: {
  connection: McpConnectionRow | null;
  onClose: () => void;
}) {
  const update = useUpdateMcpConnection();
  const [error, setError] = useState<string | null>(null);

  // Pre-fill from the row; keyed by connection id below so the form resets when a
  // different row is opened. Timeouts render as their number or blank (= default).
  const [form, setForm] = useState({
    callTimeoutMs: connection?.config?.callTimeoutMs?.toString() ?? '',
    listTimeoutMs: connection?.config?.listTimeoutMs?.toString() ?? '',
    name: connection?.name ?? '',
    url: connection?.config?.url ?? '',
  });

  if (!connection) {
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!connection) {
      return;
    }
    setError(null);
    // Blank → null → omit from the body → the PATCH rebuilds config without it,
    // clearing the override back to the loadMcpTools default.
    const parsed = parseTimeoutInputs(form);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    try {
      await update.mutateAsync({
        body: {
          name: form.name,
          url: form.url,
          ...(parsed.listTimeoutMs !== null ? { listTimeoutMs: parsed.listTimeoutMs } : {}),
          ...(parsed.callTimeoutMs !== null ? { callTimeoutMs: parsed.callTimeoutMs } : {}),
        },
        id: connection.id,
      });
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Failed to update connection'));
    }
  }

  return (
    <Modal onClose={onClose} open={!!connection} title={`Edit "${connection.name}"`}>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Input
          id="mcp-edit-name"
          label="Name"
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
          value={form.name}
        />
        <Input
          id="mcp-edit-server-url"
          label="Server URL (http/https)"
          onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
          required
          type="url"
          value={form.url}
        />
        <McpTimeoutFields
          callTimeoutMs={form.callTimeoutMs}
          idPrefix="mcp-edit"
          listTimeoutMs={form.listTimeoutMs}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
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

export default function StudioMcpConnectionsPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<McpConnectionRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpConnectionRow | null>(null);
  const { data: connections, isLoading, isError, error: loadError } = useMcpConnections();
  const del = useDeleteMcpConnection();

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            Create connection
          </Button>
        }
        chapter="§ Studio"
        subtitle={
          <>
            MCP servers (http/https) that an Agent can bind tools from. Attach one to an Agent via
            its <code className="text-paper-300">mcpConnectionId</code> and add{' '}
            <code className="text-paper-300">mcp</code> to its tool keys; the server&apos;s tools
            then load at run time alongside the agent&apos;s built-in tools.
          </>
        }
        title="MCP connections"
      />

      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="MCP connections"
      >
        {
          <Card>
            <CardHeader>
              <CardTitle>Connections</CardTitle>
            </CardHeader>
            {!connections || connections.length === 0 ? (
              <EmptyState
                className="py-4"
                title="No MCP connections yet. Create one to enable MCP tools for an agent."
              />
            ) : (
              <Table>
                <THead>
                  <Th variant="compact">Name</Th>
                  <Th variant="compact">URL</Th>
                  <Th variant="compact">Timeouts (list/call ms)</Th>
                  <Th variant="compact">Team</Th>
                  <Th variant="compact" />
                </THead>
                <tbody>
                  {connections.map((c) => (
                    <TRow key={c.id}>
                      <Td className="py-2 pr-4 font-mono text-xs text-paper-100">{c.name}</Td>
                      <Td className="max-w-xs py-2 pr-4">
                        <code className="block truncate font-mono text-[11px] text-paper-300">
                          {c.config?.url}
                        </code>
                      </Td>
                      <Td className="py-2 pr-4 text-xs text-paper-300">
                        {c.config?.listTimeoutMs ?? 'default'} /{' '}
                        {c.config?.callTimeoutMs ?? 'default'}
                      </Td>
                      <Td className="py-2 pr-4 text-xs text-paper-300">{c.team?.name ?? '—'}</Td>
                      <Td className="py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <Button onClick={() => setEditTarget(c)} size="sm" variant="secondary">
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
          </Card>
        }
      </QueryBoundary>

      <CreateMcpConnectionModal onClose={() => setNewOpen(false)} open={newOpen} />
      <EditMcpConnectionModal
        connection={editTarget}
        key={editTarget?.id}
        onClose={() => setEditTarget(null)}
      />
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message="Agents referencing this connection will fall back to their built-in tools. This deactivates the connection; it cannot be undone."
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await del.mutateAsync(deleteTarget.id);
          }
        }}
        open={deleteTarget !== null}
        pendingLabel="Deleting…"
        title={`Delete "${deleteTarget?.name ?? ''}"?`}
      />
    </div>
  );
}
