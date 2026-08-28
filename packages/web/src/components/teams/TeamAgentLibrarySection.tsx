'use client';

import { useState } from 'react';
import {
  cleanAgentPayload,
  SkillRefEditor,
  ToolKeysEditor,
} from '@/components/agents/AgentEditorFields';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import {
  type AgentRow,
  type AgentSkillRef,
  type CreateTeamAgentBody,
  type SkillRefInput,
  type UpdateAgentBody,
  useCreateTeamAgent,
  useDeleteTeamAgent,
  useTeamAgents,
  useUpdateTeamAgent,
} from '@/hooks/useAgentLibrary';
import { useMcpConnections } from '@/hooks/useMcpConnections';
import { useSkills } from '@/hooks/useSkills';
import { errMsg } from '@/lib/errors';

const EMPTY: CreateTeamAgentBody = {
  description: '',
  inheritsModelFrom: '',
  key: '',
  modelSpec: '',
  name: '',
  skillRefs: [],
  systemPrompt: '',
  toolKeys: null,
};

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
  const deleteAgent = useDeleteTeamAgent(teamId);
  const { data: mcpConnections } = useMcpConnections();
  const { data: skills } = useSkills();

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateTeamAgentBody>(EMPTY);
  const [editing, setEditing] = useState<AgentRow | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<AgentRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submitDelete() {
    if (!deleteConfirm) {
      return;
    }
    setError(null);
    try {
      await deleteAgent.mutateAsync(deleteConfirm.id);
      setDeleteConfirm(null);
    } catch (e) {
      setError(errMsg(e, 'Delete failed'));
    }
  }

  async function submitCreate() {
    setError(null);
    try {
      await createAgent.mutateAsync(cleanAgentPayload({ ...form }) as CreateTeamAgentBody);
      setCreateOpen(false);
      setForm(EMPTY);
    } catch (e) {
      setError(errMsg(e, 'Create failed'));
    }
  }

  async function submitEdit() {
    if (!editing) {
      return;
    }
    setError(null);
    try {
      const skillRefsPayload: SkillRefInput[] = (editing.skillRefs ?? []).map((r, i) => ({
        skillId: r.skillId,
        sortOrder: i,
      }));
      await updateAgent.mutateAsync({
        body: {
          ...(cleanAgentPayload({
            description: editing.description ?? '',
            inheritsModelFrom: editing.inheritsModelFrom ?? '',
            modelSpec: editing.modelSpec ?? '',
            name: editing.name,
            systemPrompt: editing.systemPrompt ?? '',
          }) as UpdateAgentBody),
          mcpConnectionId: editing.mcpConnectionId ?? null,
          skillRefs: skillRefsPayload,
          toolKeys: editing.toolKeys,
        },
        id: editing.id,
      });
      setEditing(null);
    } catch (e) {
      setError(errMsg(e, 'Update failed'));
    }
  }

  function setEditSkillRefs(refs: SkillRefInput[]) {
    if (!editing) {
      return;
    }
    const asAgentRefs: AgentSkillRef[] = refs.map((r, i) => ({
      id: `${r.skillId}-${i}`,
      skill: { id: r.skillId, name: skills?.find((s) => s.id === r.skillId)?.name ?? r.skillId },
      skillId: r.skillId,
      sortOrder: r.sortOrder,
    }));
    setEditing({ ...editing, skillRefs: asAgentRefs });
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
              <th className="py-2 pr-3">Key</th>
              <th className="py-2 pr-3">Model</th>
              <th className="py-2 pr-3">Skills</th>
              <th className="py-2 pr-3">Ver</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {(agents ?? []).map((a) => (
              <tr className="border-b border-ink-600 last:border-0" key={a.id}>
                <td className="py-2 pr-3 font-mono text-[11px] text-paper-200">{a.key}</td>
                <td className="py-2 pr-3 font-mono text-[11px] text-paper-400">{modelLabel(a)}</td>
                <td className="py-2 pr-3 font-mono text-[11px] text-paper-400">
                  {a.skillRefs.length > 0 ? a.skillRefs.length : '—'}
                </td>
                <td className="py-2 pr-3 tabular-nums text-paper-400">v{a.version}</td>
                <td className="py-2 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button onClick={() => setEditing({ ...a })} size="sm" variant="ghost">
                      Edit
                    </Button>
                    <Button onClick={() => setDeleteConfirm(a)} size="sm" variant="ghost">
                      <span className="text-brick-400">Delete</span>
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Create */}
      <Modal
        onClose={() => setCreateOpen(false)}
        open={createOpen}
        size="lg"
        title="New team agent"
      >
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-4">
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
          </div>
          <Input
            label="Description (optional)"
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            value={form.description ?? ''}
          />
          <div className="grid grid-cols-2 gap-4">
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
          </div>
          <Textarea
            hint="Leave blank to inherit the GLOBAL prompt"
            label="System prompt (optional)"
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            rows={8}
            value={form.systemPrompt ?? ''}
          />
          <ToolKeysEditor
            onChange={(v) => setForm({ ...form, toolKeys: v })}
            value={form.toolKeys ?? null}
          />
          <FieldWrapper label="Skills">
            <SkillRefEditor
              onChange={(refs) => setForm({ ...form, skillRefs: refs })}
              refs={form.skillRefs ?? []}
              skills={skills ?? []}
            />
          </FieldWrapper>
          <Select
            hint="Bind this MCP server's tools at run time"
            label="MCP connection (optional)"
            onChange={(e) => setForm({ ...form, mcpConnectionId: e.target.value || null })}
            value={form.mcpConnectionId ?? ''}
          >
            <option value="">None</option>
            {mcpConnections?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.config?.url}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex justify-end gap-2 pt-2">
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
      </Modal>

      {/* Edit */}
      <Modal
        onClose={() => setEditing(null)}
        open={editing !== null}
        size="lg"
        subtitle={editing ? `${editing.key} · v${editing.version} → v${editing.version + 1}` : ''}
        title="Edit team agent"
      >
        {editing ? (
          <>
            <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Name"
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  value={editing.name}
                />
                <Input
                  label="Description"
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  value={editing.description ?? ''}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
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
              </div>
              <Textarea
                hint="Leave blank to inherit the GLOBAL prompt"
                label="System prompt"
                onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })}
                rows={8}
                value={editing.systemPrompt ?? ''}
              />
              <ToolKeysEditor
                onChange={(v) => setEditing({ ...editing, toolKeys: v })}
                value={editing.toolKeys}
              />
              <FieldWrapper label="Skills">
                <SkillRefEditor
                  onChange={(refs) => setEditSkillRefs(refs)}
                  refs={(editing.skillRefs ?? []).map((r) => ({
                    skillId: r.skillId,
                    sortOrder: r.sortOrder,
                  }))}
                  skills={skills ?? []}
                />
              </FieldWrapper>
              <Select
                label="MCP connection"
                onChange={(e) =>
                  setEditing({ ...editing, mcpConnectionId: e.target.value || null })
                }
                value={editing.mcpConnectionId ?? ''}
              >
                <option value="">None</option>
                {mcpConnections?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.config?.url}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={() => setEditing(null)} variant="secondary">
                Cancel
              </Button>
              <Button disabled={updateAgent.isPending} onClick={submitEdit} variant="primary">
                Save new version
              </Button>
            </div>
          </>
        ) : null}
      </Modal>

      {/* Delete confirmation */}
      <Modal
        onClose={() => setDeleteConfirm(null)}
        open={deleteConfirm !== null}
        title="Delete team agent"
      >
        {deleteConfirm ? (
          <>
            <p className="mb-4 text-sm text-paper-300">
              Deactivate <span className="font-mono text-paper-100">{deleteConfirm.key}</span> for
              this team? GLOBAL agents are unaffected — runs will fall through to the GLOBAL
              version.
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setDeleteConfirm(null)} variant="secondary">
                Cancel
              </Button>
              <Button disabled={deleteAgent.isPending} onClick={submitDelete} variant="primary">
                Delete
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </Card>
  );
}
