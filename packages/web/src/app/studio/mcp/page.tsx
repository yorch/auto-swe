'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
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
  type McpTestResult,
  useCreateMcpConnection,
  useDeleteMcpConnection,
  useMcpConnections,
  useTestMcpConnection,
  useUpdateMcpConnection,
} from '@/hooks/useMcpConnections';
import { useTeams } from '@/hooks/useTeams';
import { scopeLabel } from '@/lib/agentDisplay';
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
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          hint="The team owns the connection and manages it. Platform-wide agents can use any connection; a team's own agents can only use that team's."
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
  const {
    data: connections,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useMcpConnections();
  const del = useDeleteMcpConnection();
  const test = useTestMcpConnection();
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, McpTestResult>>({});

  async function runTest(id: string) {
    setTesting(id);
    try {
      const result = await test.mutateAsync(id);
      setResults((r) => ({ ...r, [id]: result }));
    } catch (err) {
      setResults((r) => ({
        ...r,
        [id]: { durationMs: 0, error: errMsg(err, 'The check could not run.'), ok: false },
      }));
    } finally {
      setTesting(null);
    }
  }

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
            MCP servers (http or https) whose tools an agent can call. Choose one in an agent&apos;s
            MCP connection field in the Agent library; its tools then load at run time alongside the
            agent&apos;s built-in tools. Use Test to check the server is reachable.
          </>
        }
        title="MCP connections"
      />

      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="MCP connections"
        onRetry={() => void refetch()}
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
                  <Th variant="compact">Used by</Th>
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
                      <Td className="py-2 pr-4 text-xs text-paper-300">
                        {(c.usedBy ?? []).length === 0
                          ? 'No agents'
                          : (c.usedBy ?? []).map((a) => (
                              <div key={`${a.key}-${a.scope}`}>
                                {a.name}{' '}
                                <span className="text-paper-500">({scopeLabel(a.scope)})</span>
                              </div>
                            ))}
                      </Td>
                      <Td className="py-2 text-right">
                        {results[c.id] && (
                          <div className="mb-1 flex justify-end">
                            <Badge tone={results[c.id].ok ? 'moss' : 'brick'} variant="text">
                              {results[c.id].ok
                                ? `Reachable · ${results[c.id].toolCount} ${
                                    results[c.id].toolCount === 1 ? 'tool' : 'tools'
                                  }`
                                : (results[c.id].error ?? 'Not reachable')}
                            </Badge>
                          </div>
                        )}
                        {results[c.id]?.ok && (results[c.id].toolNames ?? []).length > 0 && (
                          <div className="mb-1 text-right text-[11px] text-paper-500">
                            {(results[c.id].toolNames ?? []).join(', ')}
                          </div>
                        )}
                        <div className="flex justify-end gap-2">
                          <Button
                            disabled={testing === c.id}
                            onClick={() => runTest(c.id)}
                            size="sm"
                            variant="ghost"
                          >
                            {testing === c.id ? 'Testing…' : 'Test'}
                          </Button>
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
        message={
          (deleteTarget?.usedBy ?? []).length > 0
            ? `${(deleteTarget?.usedBy ?? []).map((a) => a.name).join(', ')} use this connection and will fall back to their built-in tools. This deactivates the connection; it cannot be undone.`
            : 'No agent uses this connection. This deactivates it; it cannot be undone.'
        }
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
