'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SecretStatusRow } from '@/components/ui/SecretStatusRow';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type McpConnectionRow,
  type McpHeaderInput,
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
/** A per-connection timeout for the list: its value in seconds, or the built-in default. */
function msLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) {
    return 'Default';
  }
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

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

/**
 * The write-only bearer token field. The stored token is never shown, so the field is blank
 * either way: typing replaces it, leaving it blank keeps it, and "Clear stored token" removes it
 * on save. `onClearChange` is only passed when a token is already stored.
 */
function McpBearerTokenField({
  clear,
  hasToken,
  id,
  onChange,
  onClearChange,
  value,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  hasToken: boolean;
  clear?: boolean;
  onClearChange?: (v: boolean) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Input
        autoComplete="off"
        className="font-mono"
        disabled={clear}
        hint={
          clear
            ? 'The stored token is removed when you save.'
            : hasToken
              ? 'A token is stored. Leave blank to keep it, or enter a new one to replace it.'
              : 'Only needed when the server requires authentication. Sent as a bearer token to this server only.'
        }
        id={id}
        label="Bearer token (optional)"
        onChange={(e) => onChange(e.target.value)}
        placeholder={hasToken ? '••••••••' : 'Not set'}
        type="password"
        value={value}
      />
      {hasToken && onClearChange && (
        <SecretStatusRow
          action={{
            label: clear ? 'Keep stored token' : 'Clear stored token',
            onClick: () => {
              onClearChange(!clear);
              onChange('');
            },
            pressed: clear ?? false,
          }}
        >
          {clear ? 'Will be cleared on save.' : 'Stored.'}
        </SecretStatusRow>
      )}
    </div>
  );
}

/** One row of the custom-header editor. `stored` rows keep their name; their value is write-only. */
interface HeaderRow {
  key: number;
  name: string;
  value: string;
  stored: boolean;
}

const MAX_HEADERS = 5;

/**
 * The headers to send, or an error. A new row needs both halves; a stored row with a blank value
 * keeps what is stored (`value` omitted), so a stored secret is never echoed back to the page.
 */
function headersFromRows(rows: HeaderRow[]): { error: string } | { headers: McpHeaderInput[] } {
  const headers: McpHeaderInput[] = [];
  for (const r of rows) {
    const name = r.name.trim();
    const value = r.value.trim();
    if (!name) {
      return { error: 'Give every header a name, or remove the empty row.' };
    }
    if (!(value || r.stored)) {
      return { error: `Enter a value for the ${name} header, or remove it.` };
    }
    headers.push(value ? { name, value } : { name });
  }
  return { headers };
}

/**
 * Write-only custom headers. A stored header shows its name and "Stored"; typing a value replaces
 * it, leaving it blank keeps it, Remove drops it on save. Values are masked while typed.
 */
function McpHeaderFields({
  idPrefix,
  onChange,
  rows,
}: {
  idPrefix: string;
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}) {
  const nextKey = rows.reduce((m, r) => Math.max(m, r.key + 1), 0);
  const patch = (key: number, p: Partial<HeaderRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm text-paper-300">Custom headers (optional)</legend>
      <p className="text-xs text-paper-500">
        For servers behind a gateway that needs an API key or tenant header. Values are stored
        encrypted, never shown again, and sent to this server only. Use the bearer token field for
        an Authorization header.
      </p>
      {rows.map((r, i) => (
        <div className="flex flex-wrap items-end gap-2" key={r.key}>
          <div className="min-w-32 flex-1">
            <Input
              autoComplete="off"
              id={`${idPrefix}-header-name-${r.key}`}
              label={`Header ${i + 1} name`}
              onChange={(e) => patch(r.key, { name: e.target.value })}
              placeholder="X-Api-Key"
              readOnly={r.stored}
              value={r.name}
            />
          </div>
          <div className="min-w-32 flex-1">
            <Input
              autoComplete="off"
              id={`${idPrefix}-header-value-${r.key}`}
              label={`Header ${i + 1} value`}
              onChange={(e) => patch(r.key, { value: e.target.value })}
              placeholder={r.stored ? 'Stored — leave blank to keep' : 'Value'}
              type="password"
              value={r.value}
            />
          </div>
          <Button
            aria-label={`Remove header ${i + 1}${r.name ? ` (${r.name})` : ''}`}
            onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
            size="sm"
            type="button"
            variant="ghost"
          >
            Remove
          </Button>
        </div>
      ))}
      {rows.length < MAX_HEADERS && (
        <Button
          onClick={() => onChange([...rows, { key: nextKey, name: '', stored: false, value: '' }])}
          size="sm"
          type="button"
          variant="secondary"
        >
          Add header
        </Button>
      )}
    </fieldset>
  );
}

/** The admin's opt-in for a server on an internal address. */
function McpPrivateNetworkField({
  checked,
  id,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Checkbox
      checked={checked}
      hint="Tick this for a server on an internal network address (for example 10.x or 192.168.x). The platform's own addresses, link-local addresses and cloud metadata endpoints are always refused."
      id={id}
      label="This server is on a private network"
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function CreateMcpConnectionModal({ onClose, open }: { onClose: () => void; open: boolean }) {
  const { data: teams } = useTeams();
  const create = useCreateMcpConnection();
  const initialForm = {
    allowPrivateNetwork: false,
    bearerToken: '',
    callTimeoutMs: '',
    listTimeoutMs: '',
    name: '',
    teamId: '',
    url: '',
  };
  const [form, setForm] = useState(initialForm);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
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
    const headers = headersFromRows(headerRows);
    if ('error' in headers) {
      setError(headers.error);
      return;
    }
    try {
      await create.mutateAsync({
        ...(form.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
        ...(headers.headers.length
          ? { headers: headers.headers.map((h) => ({ name: h.name, value: h.value ?? '' })) }
          : {}),
        ...(form.bearerToken.trim() ? { bearerToken: form.bearerToken.trim() } : {}),
        name: form.name,
        teamId: form.teamId,
        url: form.url,
        ...(parsed.listTimeoutMs !== null ? { listTimeoutMs: parsed.listTimeoutMs } : {}),
        ...(parsed.callTimeoutMs !== null ? { callTimeoutMs: parsed.callTimeoutMs } : {}),
      });
      onClose();
      setForm(initialForm);
      setHeaderRows([]);
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
        <McpPrivateNetworkField
          checked={form.allowPrivateNetwork}
          id="mcp-new-private-network"
          onChange={(v) => setForm((f) => ({ ...f, allowPrivateNetwork: v }))}
        />
        <McpBearerTokenField
          hasToken={false}
          id="mcp-new-bearer-token"
          onChange={(v) => setForm((f) => ({ ...f, bearerToken: v }))}
          value={form.bearerToken}
        />
        <McpHeaderFields idPrefix="mcp-new" onChange={setHeaderRows} rows={headerRows} />
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
    allowPrivateNetwork: connection?.config?.allowPrivateNetwork === true,
    bearerToken: '',
    callTimeoutMs: connection?.config?.callTimeoutMs?.toString() ?? '',
    listTimeoutMs: connection?.config?.listTimeoutMs?.toString() ?? '',
    name: connection?.name ?? '',
    url: connection?.config?.url ?? '',
  });
  const [clearToken, setClearToken] = useState(false);
  const [removedUnreadable, setRemovedUnreadable] = useState(false);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() =>
    (connection?.headerNames ?? []).map((name, key) => ({ key, name, stored: true, value: '' }))
  );

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
    const headers = headersFromRows(headerRows);
    if ('error' in headers) {
      setError(headers.error);
      return;
    }
    // Omitted keeps every stored header; a list (even empty) is the complete set after the save.
    // Unreadable stored headers count as touched: the gateway refuses an edit that leaves them
    // unmentioned (it cannot tell whether to keep them), so the save must state the new set.
    const touchedHeaders =
      headerRows.length > 0 ||
      (connection.headerNames ?? []).length > 0 ||
      connection.headersUnreadable === true;
    try {
      await update.mutateAsync({
        body: {
          ...(form.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
          ...(touchedHeaders ? { headers: headers.headers } : {}),
          ...(form.bearerToken.trim() ? { bearerToken: form.bearerToken.trim() } : {}),
          ...(clearToken ? { clearBearerToken: true } : {}),
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
        <McpPrivateNetworkField
          checked={form.allowPrivateNetwork}
          id="mcp-edit-private-network"
          onChange={(v) => setForm((f) => ({ ...f, allowPrivateNetwork: v }))}
        />
        <McpBearerTokenField
          clear={clearToken}
          hasToken={!!connection.hasToken}
          id="mcp-edit-bearer-token"
          onChange={(v) => setForm((f) => ({ ...f, bearerToken: v }))}
          onClearChange={setClearToken}
          value={form.bearerToken}
        />
        {connection.headersUnreadable && (
          <Alert>
            <p>
              The stored headers can no longer be read, so they are not being sent. Remove them, or
              enter the headers again below to replace them.
            </p>
            {removedUnreadable ? (
              <p className="mt-2 font-medium">The stored headers will be removed when you save.</p>
            ) : (
              <Button
                className="mt-2"
                onClick={() => {
                  setHeaderRows([]);
                  setRemovedUnreadable(true);
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                Remove stored headers
              </Button>
            )}
          </Alert>
        )}
        <McpHeaderFields idPrefix="mcp-edit" onChange={setHeaderRows} rows={headerRows} />
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
    <div className="space-y-6">
      <PageHeader
        actions={
          // While the list is empty its empty state carries the same button.
          connections?.length ? (
            <Button onClick={() => setNewOpen(true)} variant="primary">
              <Icon name="plus" size={14} />
              Create connection
            </Button>
          ) : undefined
        }
        subtitle={
          <>
            MCP servers whose tools an agent can call. Choose one in an agent&apos;s MCP connection
            field in the Agent library. A bearer token and custom headers, if the server needs them,
            are stored encrypted and never shown again.
          </>
        }
        title="MCP connections"
      />

      <Card className="p-4 sm:p-6">
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="MCP connections"
          loading={<SkeletonRows rows={3} />}
          onRetry={() => void refetch()}
        >
          {!connections || connections.length === 0 ? (
            <EmptyState
              action={
                <Button onClick={() => setNewOpen(true)} size="sm" variant="primary">
                  Create connection
                </Button>
              }
              hint="Connect an MCP server, then pick it in an agent's MCP connection field to let that agent call its tools."
              icon="plug"
              title="No MCP connections yet"
            />
          ) : (
            <Table stacked>
              <THead>
                <Th className="pl-0" variant="plain">
                  Connection
                </Th>
                <Th variant="plain">Authentication</Th>
                <Th variant="plain">Timeouts (list / call)</Th>
                <Th variant="plain">Team</Th>
                <Th variant="plain">Used by</Th>
                <Th className="pr-0" variant="plain">
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <tbody>
                {connections.map((c) => {
                  const result = results[c.id];
                  const usedBy = c.usedBy ?? [];
                  return (
                    <TRow key={c.id}>
                      <Td className="py-3 pr-4 align-top sm:max-w-xs" primary>
                        <div className="truncate font-medium text-paper-100">{c.name}</div>
                        <code
                          className="mt-0.5 block truncate font-mono text-xs text-paper-500"
                          title={c.config?.url}
                        >
                          {c.config?.url}
                        </code>
                        {result && (
                          <div className="mt-1.5 space-y-1">
                            <Badge dot tone={result.ok ? 'moss' : 'brick'}>
                              {result.ok
                                ? `Reachable · ${result.toolCount} ${
                                    result.toolCount === 1 ? 'tool' : 'tools'
                                  }`
                                : (result.error ?? 'Not reachable')}
                            </Badge>
                            {result.ok && (result.toolNames ?? []).length > 0 && (
                              <div className="font-mono text-xs text-paper-500">
                                {(result.toolNames ?? []).join(', ')}
                              </div>
                            )}
                          </div>
                        )}
                      </Td>
                      <Td
                        className="px-4 py-3 align-top text-xs text-paper-300"
                        label="Authentication"
                      >
                        <div>{c.hasToken ? 'Bearer token stored' : 'No authentication'}</div>
                        {(c.headerNames ?? []).length > 0 && (
                          <div className="mt-0.5 text-paper-500">
                            {`Headers: ${(c.headerNames ?? []).join(', ')}`}
                          </div>
                        )}
                        {c.config?.allowPrivateNetwork && (
                          <Badge className="mt-1" tone="amber" variant="outline">
                            Private network
                          </Badge>
                        )}
                      </Td>
                      <Td
                        className="px-4 py-3 align-top text-xs text-paper-300 tabular-nums"
                        label="Timeouts (list / call)"
                      >
                        {msLabel(c.config?.listTimeoutMs)} / {msLabel(c.config?.callTimeoutMs)}
                      </Td>
                      <Td className="px-4 py-3 align-top text-xs text-paper-300" label="Team">
                        {c.team?.name ?? <span className="text-paper-500">All teams</span>}
                      </Td>
                      <Td className="px-4 py-3 align-top text-xs text-paper-300" label="Used by">
                        {usedBy.length === 0 ? (
                          <span className="text-paper-500">No agents</span>
                        ) : (
                          usedBy.map((a) => (
                            <div key={`${a.key}-${a.scope}`}>
                              {a.name}{' '}
                              <span className="text-paper-500">({scopeLabel(a.scope)})</span>
                            </div>
                          ))
                        )}
                      </Td>
                      <Td className="py-3 pl-4 text-right align-top">
                        <div className="flex justify-end gap-1">
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
                          <Button
                            aria-label={`Delete ${c.name}`}
                            onClick={() => setDeleteTarget(c)}
                            size="sm"
                            variant="ghost"
                          >
                            <Icon className="text-brick-400" name="trash" size={14} />
                          </Button>
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
