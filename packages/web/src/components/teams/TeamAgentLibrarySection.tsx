'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import {
  type AgentRow,
  type CreateTeamAgentBody,
  type UpdateAgentBody,
  useCreateTeamAgent,
  useTeamAgents,
  useUpdateTeamAgent,
} from '@/hooks/useAgentLibrary';

const EMPTY: CreateTeamAgentBody = {
  inheritsModelFrom: '',
  key: '',
  modelSpec: '',
  name: '',
  systemPrompt: '',
};

function clean(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined));
}

function modelLabel(a: AgentRow): string {
  if (a.modelSpec) {
    return a.modelSpec;
  }
  if (a.inheritsModelFrom) {
    return `↳ ${a.inheritsModelFrom}`;
  }
  return '—';
}

/**
 * Team-owner editor for TEAM-scope Agents — per-team overrides of the GLOBAL
 * library, resolved by `resolveAgent` ahead of GLOBAL for this team's runs.
 */
export function TeamAgentLibrarySection({ teamId }: { teamId: string }) {
  const { data: agents, isLoading } = useTeamAgents(teamId);
  const createAgent = useCreateTeamAgent(teamId);
  const updateAgent = useUpdateTeamAgent(teamId);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateTeamAgentBody>(EMPTY);
  const [editing, setEditing] = useState<AgentRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submitCreate() {
    setError(null);
    try {
      await createAgent.mutateAsync(clean({ ...form }) as unknown as CreateTeamAgentBody);
      setCreateOpen(false);
      setForm(EMPTY);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    }
  }

  async function submitEdit() {
    if (!editing) {
      return;
    }
    setError(null);
    try {
      await updateAgent.mutateAsync({
        body: clean({
          inheritsModelFrom: editing.inheritsModelFrom ?? '',
          modelSpec: editing.modelSpec ?? '',
          name: editing.name,
          systemPrompt: editing.systemPrompt ?? '',
        }) as unknown as UpdateAgentBody,
        id: editing.id,
      });
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="TEAM scope">Agent overrides</CardTitle>
        <Button onClick={() => setCreateOpen(true)} size="sm" variant="primary">
          + New
        </Button>
      </CardHeader>
      <p className="mb-3 text-xs text-paper-400">
        Per-team Agents override the GLOBAL library for this team's runs. Leave a field blank to
        inherit from GLOBAL.
      </p>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {isLoading ? (
        <LoadingState />
      ) : (agents ?? []).length === 0 ? (
        <p className="py-3 text-center text-xs text-paper-500">No team overrides yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-600 text-left text-xs text-paper-500">
              <th className="py-2">Key</th>
              <th className="py-2">Model</th>
              <th className="py-2">Ver</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {(agents ?? []).map((a) => (
              <tr className="border-b border-ink-600 last:border-0" key={a.id}>
                <td className="py-2 pr-4 font-mono text-[11px] text-paper-200">{a.key}</td>
                <td className="py-2 pr-4 font-mono text-[11px] text-paper-400">{modelLabel(a)}</td>
                <td className="py-2 pr-4 tabular-nums text-paper-400">v{a.version}</td>
                <td className="py-2 text-right">
                  <Button onClick={() => setEditing(a)} size="sm" variant="ghost">
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal onClose={() => setCreateOpen(false)} open={createOpen} title="New team agent">
        <div className="space-y-4">
          <Input
            hint="GLOBAL key to override (e.g. reviewer) or a new custom key"
            label="Key"
            onChange={(e) => setForm({ ...form, key: e.target.value })}
            value={form.key}
          />
          <Input
            label="Name"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            value={form.name}
          />
          <Input
            hint="<provider>/<model>, or blank to inherit"
            label="Model spec (optional)"
            onChange={(e) => setForm({ ...form, modelSpec: e.target.value })}
            value={form.modelSpec ?? ''}
          />
          <Input
            hint="Parent agent key to inherit the model from"
            label="Inherits model from (optional)"
            onChange={(e) => setForm({ ...form, inheritsModelFrom: e.target.value })}
            value={form.inheritsModelFrom ?? ''}
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setCreateOpen(false)} variant="secondary">
              Cancel
            </Button>
            <Button
              disabled={!form.key || !form.name || createAgent.isPending}
              onClick={submitCreate}
              variant="primary"
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        onClose={() => setEditing(null)}
        open={editing !== null}
        subtitle={editing ? `${editing.key} · v${editing.version} → v${editing.version + 1}` : ''}
        title="Edit team agent"
      >
        {editing ? (
          <div className="space-y-4">
            <Input
              label="Name"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              value={editing.name}
            />
            <Input
              label="Model spec"
              onChange={(e) => setEditing({ ...editing, modelSpec: e.target.value })}
              value={editing.modelSpec ?? ''}
            />
            <Input
              label="Inherits model from"
              onChange={(e) => setEditing({ ...editing, inheritsModelFrom: e.target.value })}
              value={editing.inheritsModelFrom ?? ''}
            />
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
    </Card>
  );
}
