'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  type AgentRow,
  type CreateAgentBody,
  type UpdateAgentBody,
  useAgentLibrary,
  useCreateAgent,
  useDeleteAgent,
  useUpdateAgent,
} from '@/hooks/useAgentLibrary';
import { useMcpConnections } from '@/hooks/useMcpConnections';

const EMPTY_CREATE: CreateAgentBody = {
  description: '',
  inheritsModelFrom: '',
  key: '',
  modelSpec: '',
  name: '',
  scope: 'GLOBAL',
  systemPrompt: '',
};

function modelLabel(a: AgentRow): string {
  if (a.modelSpec) {
    return a.modelSpec;
  }
  if (a.inheritsModelFrom) {
    return `↳ inherits ${a.inheritsModelFrom}`;
  }
  return '— (role default)';
}

export default function AgentLibraryPage() {
  const { data: agents, isLoading } = useAgentLibrary({ scope: 'GLOBAL' });
  const { data: mcpConnections } = useMcpConnections();
  const createAgent = useCreateAgent();
  const updateAgent = useUpdateAgent();
  const deleteAgent = useDeleteAgent();

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateAgentBody>(EMPTY_CREATE);
  const [editing, setEditing] = useState<AgentRow | null>(null);
  const [deleting, setDeleting] = useState<AgentRow | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Strip empty strings so optional fields are sent as undefined.
  function clean(o: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined));
  }

  async function submitCreate() {
    setError(null);
    setWarnings([]);
    try {
      const res = await createAgent.mutateAsync(
        clean({ ...createForm }) as unknown as CreateAgentBody
      );
      setWarnings(res.scanWarnings ?? []);
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    }
  }

  async function submitEdit() {
    if (!editing) {
      return;
    }
    setError(null);
    setWarnings([]);
    try {
      const res = await updateAgent.mutateAsync({
        body: {
          ...(clean({
            description: editing.description ?? '',
            inheritsModelFrom: editing.inheritsModelFrom ?? '',
            modelSpec: editing.modelSpec ?? '',
            name: editing.name,
            systemPrompt: editing.systemPrompt ?? '',
          }) as unknown as UpdateAgentBody),
          // Always sent (outside clean) so an explicit "None" clears it.
          mcpConnectionId: editing.mcpConnectionId ?? null,
        },
        id: editing.id,
      });
      setWarnings(res.scanWarnings ?? []);
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold">Agent Library</h2>
          <p className="mt-1 text-sm text-paper-400">
            First-class, versioned Agents. A null model/prompt/tool override inherits from the role
            defaults; editing an Agent cuts a new version, and running workflows stay pinned to the
            version they started with.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} variant="primary">
          + New Agent
        </Button>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}
      {warnings.length > 0 ? (
        <Alert variant="error">Content scan warnings: {warnings.join('; ')}</Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle eyebrow="GLOBAL scope">Agents</CardTitle>
        </CardHeader>
        {isLoading ? (
          <LoadingState />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-600 text-left text-xs text-paper-500">
                <th className="py-2">Key</th>
                <th className="py-2">Name</th>
                <th className="py-2">Model</th>
                <th className="py-2">Ver</th>
                <th className="py-2">Verified</th>
                <th className="py-2">Origin</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {(agents ?? []).map((a) => (
                <tr className="border-b border-ink-600 last:border-0" key={a.id}>
                  <td className="py-3 pr-4 font-mono text-[11px] text-paper-200">{a.key}</td>
                  <td className="py-3 pr-4 text-paper-100">{a.name}</td>
                  <td className="py-3 pr-4 font-mono text-[11px] text-paper-400">
                    {modelLabel(a)}
                  </td>
                  <td className="py-3 pr-4 tabular-nums text-paper-400">v{a.version}</td>
                  <td className="py-3 pr-4">
                    <span className={a.isVerified ? 'text-moss-400' : 'text-paper-500'}>
                      {a.isVerified ? '✓' : '—'}
                    </span>
                  </td>
                  <td className="py-3 pr-4 font-mono text-[10px] uppercase tracking-wider text-paper-500">
                    {a.origin ?? 'custom'}
                  </td>
                  <td className="py-3 text-right">
                    <Button onClick={() => setEditing(a)} size="sm" variant="ghost">
                      Edit
                    </Button>
                    <Button onClick={() => setDeleting(a)} size="sm" variant="ghost">
                      Deactivate
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Create */}
      <Modal onClose={() => setCreateOpen(false)} open={createOpen} title="New Agent">
        <div className="space-y-4">
          <Input
            label="Key"
            onChange={(e) => setCreateForm({ ...createForm, key: e.target.value })}
            placeholder="codeReviewer"
            value={createForm.key}
          />
          <Input
            label="Name"
            onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
            placeholder="Code Reviewer"
            value={createForm.name}
          />
          <Input
            hint="<provider>/<model>, or leave blank to inherit"
            label="Model spec (optional)"
            onChange={(e) => setCreateForm({ ...createForm, modelSpec: e.target.value })}
            placeholder="anthropic/claude-opus-4-7"
            value={createForm.modelSpec ?? ''}
          />
          <Input
            hint="Parent agent key to inherit the model from (sub-roles)"
            label="Inherits model from (optional)"
            onChange={(e) => setCreateForm({ ...createForm, inheritsModelFrom: e.target.value })}
            placeholder="reviewer"
            value={createForm.inheritsModelFrom ?? ''}
          />
          <Select
            hint="Bind this MCP server's tools at run time (also add 'mcp' to the agent's tool keys)"
            label="MCP connection (optional)"
            onChange={(e) =>
              setCreateForm({ ...createForm, mcpConnectionId: e.target.value || null })
            }
            value={createForm.mcpConnectionId ?? ''}
          >
            <option value="">None</option>
            {mcpConnections?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.config?.url}
              </option>
            ))}
          </Select>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setCreateOpen(false)} variant="secondary">
              Cancel
            </Button>
            <Button
              disabled={!createForm.key || !createForm.name || createAgent.isPending}
              onClick={submitCreate}
              variant="primary"
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit */}
      <Modal
        onClose={() => setEditing(null)}
        open={editing !== null}
        subtitle={editing ? `${editing.key} · v${editing.version} → v${editing.version + 1}` : ''}
        title="Edit Agent"
      >
        {editing ? (
          <div className="space-y-4">
            <Input
              label="Name"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              value={editing.name}
            />
            <Input
              hint="Leave blank to inherit from the role default"
              label="Model spec"
              onChange={(e) => setEditing({ ...editing, modelSpec: e.target.value })}
              value={editing.modelSpec ?? ''}
            />
            <Input
              label="Inherits model from"
              onChange={(e) => setEditing({ ...editing, inheritsModelFrom: e.target.value })}
              value={editing.inheritsModelFrom ?? ''}
            />
            <Select
              hint="Bind this MCP server's tools at run time (also add 'mcp' to the agent's tool keys)"
              label="MCP connection"
              onChange={(e) => setEditing({ ...editing, mcpConnectionId: e.target.value || null })}
              value={editing.mcpConnectionId ?? ''}
            >
              <option value="">None</option>
              {mcpConnections?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.config?.url}
                </option>
              ))}
            </Select>
            <p className="text-xs text-paper-500">
              Saving cuts a new version. A system-prompt change resets verification and is content-
              scanned.
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setEditing(null)} variant="secondary">
                Cancel
              </Button>
              <Button disabled={updateAgent.isPending} onClick={submitEdit} variant="primary">
                Save new version
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmModal
        confirmLabel="Deactivate"
        dangerous
        message={
          deleting
            ? `Deactivate all versions of '${deleting.key}'? Resolution falls back to the role defaults.`
            : ''
        }
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) {
            await deleteAgent.mutateAsync(deleting.id);
            setDeleting(null);
          }
        }}
        open={deleting !== null}
        title="Deactivate Agent"
      />
    </div>
  );
}
