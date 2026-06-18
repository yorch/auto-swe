'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import {
  type AgentRow,
  type AgentSkillRef,
  type CreateAgentBody,
  type SkillRefInput,
  type UpdateAgentBody,
  useAgentLibrary,
  useCreateAgent,
  useDeleteAgent,
  useUpdateAgent,
} from '@/hooks/useAgentLibrary';
import { useAdminCredentials } from '@/hooks/useModelConfig';
import { useMcpConnections } from '@/hooks/useMcpConnections';
import { type SkillOption, useSkills } from '@/hooks/useSkills';

const ALL_TOOL_KEYS = ['readFile', 'writeFile', 'listDirectory', 'bash', 'mcp'] as const;

const EMPTY_CREATE: CreateAgentBody = {
  description: '',
  inheritsModelFrom: '',
  key: '',
  modelSpec: '',
  name: '',
  scope: 'GLOBAL',
  skillRefs: [],
  systemPrompt: '',
  toolKeys: null,
};

function modelLabel(a: AgentRow): string {
  if (a.modelSpec) return a.modelSpec;
  if (a.inheritsModelFrom) return `↳ inherits ${a.inheritsModelFrom}`;
  return '— (role default)';
}

function toolKeysLabel(toolKeys: string[] | null): string {
  if (toolKeys === null) return 'all';
  if (toolKeys.length === 0) return 'none';
  return toolKeys.join(', ');
}

// ── Skill ref list editor ─────────────────────────────────────────────────────

function SkillRefEditor({
  refs,
  skills,
  onChange,
}: {
  refs: SkillRefInput[];
  skills: SkillOption[];
  onChange: (refs: SkillRefInput[]) => void;
}) {
  const attached = new Set(refs.map((r) => r.skillId));
  const available = skills.filter((s) => !attached.has(s.id));

  function add(skillId: string) {
    onChange([...refs, { skillId, sortOrder: refs.length }]);
  }

  function remove(i: number) {
    const next = refs.filter((_, j) => j !== i).map((r, j) => ({ ...r, sortOrder: j }));
    onChange(next);
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= refs.length) return;
    const next = [...refs];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next.map((r, k) => ({ ...r, sortOrder: k })));
  }

  function nameFor(skillId: string) {
    return skills.find((s) => s.id === skillId)?.name ?? skillId;
  }

  return (
    <div className="space-y-2">
      {refs.length > 0 && (
        <ul className="space-y-1">
          {refs.map((ref, i) => (
            <li
              className="flex items-center gap-2 rounded-[9px] border border-ink-400 bg-ink-900/40 px-3 py-2 text-sm"
              key={ref.skillId}
            >
              <span className="flex-1 text-paper-200">{nameFor(ref.skillId)}</span>
              <button
                className="text-paper-500 hover:text-paper-200 disabled:opacity-30"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                type="button"
              >
                ↑
              </button>
              <button
                className="text-paper-500 hover:text-paper-200 disabled:opacity-30"
                disabled={i === refs.length - 1}
                onClick={() => move(i, 1)}
                type="button"
              >
                ↓
              </button>
              <button
                className="text-brick-400 hover:text-brick-300"
                onClick={() => remove(i)}
                type="button"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && (
        <Select
          label={refs.length === 0 ? 'Skills' : undefined}
          onChange={(e) => {
            if (e.target.value) add(e.target.value);
          }}
          value=""
        >
          <option value="">+ Add skill…</option>
          {available.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      )}
      {available.length === 0 && refs.length === 0 && (
        <p className="text-xs text-paper-500">No skills available.</p>
      )}
    </div>
  );
}

// ── Tool keys checkbox group ──────────────────────────────────────────────────

function ToolKeysEditor({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const isCustom = value !== null;

  function toggleKey(key: string, checked: boolean) {
    const current = value ?? [];
    onChange(checked ? [...current, key] : current.filter((k) => k !== key));
  }

  return (
    <FieldWrapper hint={isCustom ? undefined : 'Agent inherits all available tools'} label="Tools">
      <div className="space-y-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-paper-300">
          <input
            checked={isCustom}
            className="accent-ember-400"
            onChange={(e) => onChange(e.target.checked ? [] : null)}
            type="checkbox"
          />
          Custom tool selection
        </label>
        {isCustom && (
          <div className="grid grid-cols-3 gap-x-4 gap-y-1 pl-1">
            {ALL_TOOL_KEYS.map((key) => (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-paper-300" key={key}>
                <input
                  checked={value?.includes(key) ?? false}
                  className="accent-ember-400"
                  onChange={(e) => toggleKey(key, e.target.checked)}
                  type="checkbox"
                />
                <span className="font-mono text-xs">{key}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </FieldWrapper>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AgentLibraryPage() {
  const { data: agents, isLoading } = useAgentLibrary({ scope: 'GLOBAL' });
  const { data: mcpConnections } = useMcpConnections();
  const { data: skills } = useSkills();
  const { data: credentials } = useAdminCredentials();
  const createAgent = useCreateAgent();
  const updateAgent = useUpdateAgent();
  const deleteAgent = useDeleteAgent();

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateAgentBody>(EMPTY_CREATE);
  const [editing, setEditing] = useState<AgentRow | null>(null);
  const [deleting, setDeleting] = useState<AgentRow | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

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
    if (!editing) return;
    setError(null);
    setWarnings([]);
    try {
      const skillRefsPayload: SkillRefInput[] = (editing.skillRefs ?? []).map((r, i) => ({
        skillId: r.skillId,
        sortOrder: i,
      }));
      const res = await updateAgent.mutateAsync({
        body: {
          ...(clean({
            description: editing.description ?? '',
            inheritsModelFrom: editing.inheritsModelFrom ?? '',
            modelSpec: editing.modelSpec ?? '',
            name: editing.name,
            systemPrompt: editing.systemPrompt ?? '',
          }) as unknown as UpdateAgentBody),
          credentialId: editing.credentialId ?? null,
          mcpConnectionId: editing.mcpConnectionId ?? null,
          skillRefs: skillRefsPayload,
          toolKeys: editing.toolKeys,
        },
        id: editing.id,
      });
      setWarnings(res.scanWarnings ?? []);
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  function openEdit(a: AgentRow) {
    setEditing({ ...a });
  }

  function setEditSkillRefs(refs: SkillRefInput[]) {
    if (!editing) return;
    const asAgentRefs: AgentSkillRef[] = refs.map((r, i) => ({
      id: `${r.skillId}-${i}`,
      skillId: r.skillId,
      sortOrder: r.sortOrder,
      skill: { id: r.skillId, name: skills?.find((s) => s.id === r.skillId)?.name ?? r.skillId },
    }));
    setEditing({ ...editing, skillRefs: asAgentRefs });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold">Agent Library</h2>
          <p className="mt-1 text-sm text-paper-400">
            First-class, versioned Agents. Editing cuts a new version; running workflows stay
            pinned to the version they started with.
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
                <th className="py-2 pr-3">Key</th>
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Model</th>
                <th className="py-2 pr-3">Skills</th>
                <th className="py-2 pr-3">Tools</th>
                <th className="py-2 pr-3">Ver</th>
                <th className="py-2 pr-3">Verified</th>
                <th className="py-2 pr-3">Origin</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {(agents ?? []).map((a) => (
                <tr className="border-b border-ink-600 last:border-0" key={a.id}>
                  <td className="py-3 pr-3 font-mono text-[11px] text-paper-200">{a.key}</td>
                  <td className="py-3 pr-3">
                    <span className="text-paper-100">{a.name}</span>
                    {a.description && (
                      <div className="mt-0.5 max-w-[180px] truncate text-[11px] text-paper-500">
                        {a.description}
                      </div>
                    )}
                  </td>
                  <td className="py-3 pr-3 font-mono text-[11px] text-paper-400">
                    {modelLabel(a)}
                  </td>
                  <td className="py-3 pr-3 text-paper-400">
                    {a.skillRefs.length > 0 ? (
                      <span className="font-mono text-[11px]">{a.skillRefs.length}</span>
                    ) : (
                      <span className="text-paper-600">—</span>
                    )}
                  </td>
                  <td className="py-3 pr-3 font-mono text-[11px] text-paper-400">
                    {toolKeysLabel(a.toolKeys)}
                  </td>
                  <td className="py-3 pr-3 tabular-nums text-paper-400">v{a.version}</td>
                  <td className="py-3 pr-3">
                    <span className={a.isVerified ? 'text-moss-400' : 'text-paper-500'}>
                      {a.isVerified ? '✓' : '—'}
                    </span>
                  </td>
                  <td className="py-3 pr-3 font-mono text-[10px] uppercase tracking-wider text-paper-500">
                    {a.origin ?? 'custom'}
                  </td>
                  <td className="py-3 text-right">
                    <Button onClick={() => openEdit(a)} size="sm" variant="ghost">
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

      {/* ── Create ── */}
      <Modal onClose={() => setCreateOpen(false)} open={createOpen} size="lg" title="New Agent">
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-4">
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
          </div>
          <Input
            hint="Short summary shown in the agent table"
            label="Description (optional)"
            onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
            placeholder="Reviews pull-request diffs for correctness"
            value={createForm.description ?? ''}
          />
          <div className="grid grid-cols-2 gap-4">
            <Input
              hint="<provider>/<model>, or leave blank to inherit"
              label="Model spec (optional)"
              onChange={(e) => setCreateForm({ ...createForm, modelSpec: e.target.value })}
              placeholder="anthropic/claude-opus-4-8"
              value={createForm.modelSpec ?? ''}
            />
            <Input
              hint="Parent agent key for sub-roles"
              label="Inherits model from (optional)"
              onChange={(e) =>
                setCreateForm({ ...createForm, inheritsModelFrom: e.target.value })
              }
              placeholder="reviewer"
              value={createForm.inheritsModelFrom ?? ''}
            />
          </div>
          <Textarea
            hint="System prompt / persona. Leave blank to use the role default."
            label="System prompt (optional)"
            onChange={(e) => setCreateForm({ ...createForm, systemPrompt: e.target.value })}
            placeholder="You are a..."
            rows={8}
            value={createForm.systemPrompt ?? ''}
          />
          <ToolKeysEditor
            onChange={(v) => setCreateForm({ ...createForm, toolKeys: v })}
            value={createForm.toolKeys ?? null}
          />
          <FieldWrapper hint="Ordered list of skills injected into the system prompt" label="Skills">
            <SkillRefEditor
              onChange={(refs) => setCreateForm({ ...createForm, skillRefs: refs })}
              refs={createForm.skillRefs ?? []}
              skills={skills ?? []}
            />
          </FieldWrapper>
          <Select
            hint="Bind this MCP server's tools at run time (also enable the 'mcp' tool key above)"
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
          <Select
            hint="Use a specific provider credential instead of the system default"
            label="Credential override (optional)"
            onChange={(e) =>
              setCreateForm({ ...createForm, credentialId: e.target.value || null })
            }
            value={createForm.credentialId ?? ''}
          >
            <option value="">None (system default)</option>
            {credentials?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.provider} ···{c.lastFour}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex justify-end gap-2 pt-2">
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
      </Modal>

      {/* ── Edit ── */}
      <Modal
        onClose={() => setEditing(null)}
        open={editing !== null}
        size="lg"
        subtitle={editing ? `${editing.key} · v${editing.version} → v${editing.version + 1}` : ''}
        title="Edit Agent"
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
                  hint="Leave blank to inherit from the role default"
                  label="Model spec"
                  onChange={(e) => setEditing({ ...editing, modelSpec: e.target.value })}
                  value={editing.modelSpec ?? ''}
                />
                <Input
                  label="Inherits model from"
                  onChange={(e) =>
                    setEditing({ ...editing, inheritsModelFrom: e.target.value })
                  }
                  value={editing.inheritsModelFrom ?? ''}
                />
              </div>
              <Textarea
                hint="A change here resets verification and triggers a content scan."
                label="System prompt"
                onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })}
                rows={10}
                value={editing.systemPrompt ?? ''}
              />
              <ToolKeysEditor
                onChange={(v) => setEditing({ ...editing, toolKeys: v })}
                value={editing.toolKeys}
              />
              <FieldWrapper
                hint="Ordered list of skills injected into the system prompt"
                label="Skills"
              >
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
                hint="Bind this MCP server's tools (also enable the 'mcp' tool key)"
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
              <Select
                label="Credential override"
                onChange={(e) =>
                  setEditing({ ...editing, credentialId: e.target.value || null })
                }
                value={editing.credentialId ?? ''}
              >
                <option value="">None (system default)</option>
                {credentials?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.provider} ···{c.lastFour}
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
