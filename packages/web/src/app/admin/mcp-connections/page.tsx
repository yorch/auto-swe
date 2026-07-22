'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import {
  type McpConnectionRow,
  useCreateMcpConnection,
  useDeleteMcpConnection,
  useMcpConnections,
} from '@/hooks/useMcpConnections';
import { useTeams } from '@/hooks/useTeams';
import { parseOptionalPositiveInt } from '@/lib/parseIntInput';

function CreateMcpConnectionModal({ onClose, open }: { onClose: () => void; open: boolean }) {
  const { data: teams } = useTeams();
  const create = useCreateMcpConnection();
  const initialForm = { callTimeoutMs: '', listTimeoutMs: '', name: '', teamId: '', url: '' };
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Blank = null = omit (loadMcpTools falls back to its own default);
    // undefined = a non-positive-integer entry we reject client-side.
    const listTimeoutMs = parseOptionalPositiveInt(form.listTimeoutMs);
    const callTimeoutMs = parseOptionalPositiveInt(form.callTimeoutMs);
    if (listTimeoutMs === undefined || callTimeoutMs === undefined) {
      setError(
        'Timeouts must be positive whole numbers of milliseconds, or blank to use the default'
      );
      return;
    }
    try {
      await create.mutateAsync({
        name: form.name,
        teamId: form.teamId,
        url: form.url,
        ...(listTimeoutMs !== null ? { listTimeoutMs } : {}),
        ...(callTimeoutMs !== null ? { callTimeoutMs } : {}),
      });
      onClose();
      setForm(initialForm);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create connection');
    }
  }

  return (
    <Modal eyebrow="Admin / MCP" onClose={onClose} open={open} title="New MCP Connection">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <FieldWrapper label="Name">
          <Input
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="docs-server"
            required
            value={form.name}
          />
        </FieldWrapper>
        <FieldWrapper label="Server URL (http/https)">
          <Input
            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            placeholder="https://mcp.example.com/mcp"
            required
            type="url"
            value={form.url}
          />
        </FieldWrapper>
        <FieldWrapper label="Team">
          <Select
            onChange={(e) => setForm((f) => ({ ...f, teamId: e.target.value }))}
            required
            value={form.teamId}
          >
            <option disabled value="">
              Select a team…
            </option>
            {teams?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </FieldWrapper>
        <div className="grid grid-cols-2 gap-4">
          <FieldWrapper label="List timeout (ms)">
            <Input
              min={1}
              onChange={(e) => setForm((f) => ({ ...f, listTimeoutMs: e.target.value }))}
              placeholder="15000"
              step={1}
              type="number"
              value={form.listTimeoutMs}
            />
          </FieldWrapper>
          <FieldWrapper label="Call timeout (ms)">
            <Input
              min={1}
              onChange={(e) => setForm((f) => ({ ...f, callTimeoutMs: e.target.value }))}
              placeholder="60000"
              step={1}
              type="number"
              value={form.callTimeoutMs}
            />
          </FieldWrapper>
        </div>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={create.isPending} type="submit" variant="primary">
            {create.isPending ? 'Creating…' : 'Create Connection'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteMcpConnectionModal({
  connection,
  onClose,
}: {
  connection: McpConnectionRow | null;
  onClose: () => void;
}) {
  const del = useDeleteMcpConnection();
  const [error, setError] = useState<string | null>(null);

  if (!connection) {
    return null;
  }

  async function handleDelete() {
    if (!connection) {
      return;
    }
    setError(null);
    try {
      await del.mutateAsync(connection.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete connection');
    }
  }

  return (
    <Modal onClose={onClose} open={!!connection} title={`Delete "${connection.name}"?`}>
      <div className="space-y-4">
        <p className="text-sm text-paper-400">
          Agents referencing this connection will fall back to their built-in tools. This
          deactivates the connection; it cannot be undone.
        </p>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={del.isPending} onClick={handleDelete} variant="danger">
            {del.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function AdminMcpConnectionsPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<McpConnectionRow | null>(null);
  const { data: connections, isLoading } = useMcpConnections();

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            + New Connection
          </Button>
        }
        subtitle={
          <>
            MCP servers (http/https) that an Agent can bind tools from. Attach one to an Agent via
            its <code className="text-paper-300">mcpConnectionId</code> and add{' '}
            <code className="text-paper-300">mcp</code> to its tool keys; the server&apos;s tools
            then load at run time alongside the agent&apos;s built-in tools.
          </>
        }
        title="MCP Connections"
      />

      {isLoading ? (
        <LoadingState />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Connections</CardTitle>
          </CardHeader>
          {!connections || connections.length === 0 ? (
            <div className="py-4 text-center text-sm text-paper-400">
              No MCP connections yet. Create one to enable MCP tools for an agent.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-600">
                  <th className="py-2 text-left text-xs text-paper-500">Name</th>
                  <th className="py-2 text-left text-xs text-paper-500">URL</th>
                  <th className="py-2 text-left text-xs text-paper-500">Timeouts (list/call ms)</th>
                  <th className="py-2 text-left text-xs text-paper-500">Team</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr className="border-b border-ink-600 last:border-0" key={c.id}>
                    <td className="py-2 pr-4 font-mono text-xs text-paper-100">{c.name}</td>
                    <td className="max-w-xs py-2 pr-4">
                      <code className="block truncate font-mono text-[11px] text-paper-300">
                        {c.config?.url}
                      </code>
                    </td>
                    <td className="py-2 pr-4 text-xs text-paper-300">
                      {c.config?.listTimeoutMs ?? 'default'} /{' '}
                      {c.config?.callTimeoutMs ?? 'default'}
                    </td>
                    <td className="py-2 pr-4 text-xs text-paper-300">{c.team?.name ?? '—'}</td>
                    <td className="py-2 text-right">
                      <Button onClick={() => setDeleteTarget(c)} size="sm" variant="danger">
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <CreateMcpConnectionModal onClose={() => setNewOpen(false)} open={newOpen} />
      <DeleteMcpConnectionModal connection={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </div>
  );
}
