'use client';

import { useState } from 'react';
import { cleanAgentPayload } from '@/components/agents/AgentEditorFields';
import {
  type AgentFormCopy,
  AgentFormFields,
  type AgentFormValue,
} from '@/components/agents/AgentFormFields';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
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
import { useMcpConnections } from '@/hooks/useMcpConnections';
import { useAdminCredentials } from '@/hooks/useModelConfig';
import { useSkills } from '@/hooks/useSkills';
import { useSlackChannels } from '@/hooks/useSlackChannels';
import { errMsg } from '@/lib/errors';

const EMPTY_CREATE: CreateAgentBody = {
  channelId: undefined,
  description: '',
  inheritsModelFrom: '',
  key: '',
  modelSpec: '',
  name: '',
  orgId: undefined,
  scope: 'GLOBAL',
  skillRefs: [],
  systemPrompt: '',
  toolKeys: null,
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

function toolKeysLabel(toolKeys: string[] | null): string {
  if (toolKeys === null) {
    return 'all';
  }
  if (toolKeys.length === 0) {
    return 'none';
  }
  return toolKeys.join(', ');
}

const SKILLS_HINT = 'Ordered list of skills injected into the system prompt';

const CREATE_COPY: AgentFormCopy = {
  credential: { hint: 'Use a specific provider credential instead of the system default' },
  description: {
    hint: 'Short summary shown in the agent table',
    placeholder: 'Reviews pull-request diffs for correctness',
  },
  inheritsModelFrom: { hint: 'Parent agent key for sub-roles', placeholder: 'reviewer' },
  key: { placeholder: 'codeReviewer' },
  mcpConnection: {
    hint: "Bind this MCP server's tools at run time (also enable the 'mcp' tool key above)",
  },
  modelSpec: {
    hint: '<provider>/<model>, or leave blank to inherit',
    placeholder: 'anthropic/claude-opus-5-5',
  },
  name: { placeholder: 'Code Reviewer' },
  skills: { hint: SKILLS_HINT },
  systemPrompt: {
    hint: 'System prompt / persona. Leave blank to use the role default.',
    placeholder: 'You are a...',
  },
};

const EDIT_COPY: AgentFormCopy = {
  mcpConnection: { hint: "Bind this MCP server's tools (also enable the 'mcp' tool key)" },
  modelSpec: { hint: 'Leave blank to inherit from the role default' },
  skills: { hint: SKILLS_HINT },
  systemPrompt: { hint: 'A change here resets verification and triggers a content scan.' },
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AgentLibraryPage() {
  const {
    data: agents,
    error: loadError,
    isError,
    isLoading,
  } = useAgentLibrary({ scope: 'GLOBAL' });
  const { data: mcpConnections } = useMcpConnections();
  const { data: skills } = useSkills();
  const { data: credentials } = useAdminCredentials();
  const { data: slackChannels } = useSlackChannels();
  const createAgent = useCreateAgent();
  const updateAgent = useUpdateAgent();
  const deleteAgent = useDeleteAgent();

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateAgentBody>(EMPTY_CREATE);
  const [editing, setEditing] = useState<AgentRow | null>(null);
  const [deleting, setDeleting] = useState<AgentRow | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  async function submitCreate() {
    setCreateError(null);
    setWarnings([]);
    try {
      const res = await createAgent.mutateAsync(
        cleanAgentPayload({ ...createForm }) as CreateAgentBody
      );
      setWarnings(res.scanWarnings ?? []);
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE);
    } catch (e) {
      setCreateError(errMsg(e, 'Create failed'));
    }
  }

  async function submitEdit() {
    if (!editing) {
      return;
    }
    setEditError(null);
    setWarnings([]);
    try {
      const skillRefsPayload: SkillRefInput[] = (editing.skillRefs ?? []).map((r, i) => ({
        skillId: r.skillId,
        sortOrder: i,
      }));
      const res = await updateAgent.mutateAsync({
        body: {
          ...(cleanAgentPayload({
            description: editing.description ?? '',
            inheritsModelFrom: editing.inheritsModelFrom ?? '',
            modelSpec: editing.modelSpec ?? '',
            name: editing.name,
            systemPrompt: editing.systemPrompt ?? '',
          }) as UpdateAgentBody),
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
      setEditError(errMsg(e, 'Update failed'));
    }
  }

  function openEdit(a: AgentRow) {
    setEditError(null);
    setEditing({ ...a });
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

  function patchEditing(patch: Partial<AgentFormValue>) {
    if (!editing) {
      return;
    }
    const { skillRefs, ...rest } = patch;
    if (skillRefs !== undefined) {
      setEditSkillRefs(skillRefs ?? []);
      return;
    }
    setEditing({ ...editing, ...rest });
  }

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <Button
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
            variant="primary"
          >
            New agent
          </Button>
        }
        chapter="§ Studio"
        subtitle="First-class, versioned Agents. Editing cuts a new version; running workflows stay pinned to the version they started with."
        title="Agent library"
      />

      {warnings.length > 0 ? (
        <Alert variant="warning">Content scan warnings: {warnings.join('; ')}</Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle eyebrow="GLOBAL scope">Agents</CardTitle>
        </CardHeader>
        <QueryBoundary error={loadError} isError={isError} isLoading={isLoading} label="agents">
          <Table>
            <THead>
              <Th className="pr-3" variant="compact">
                Key
              </Th>
              <Th className="pr-3" variant="compact">
                Name
              </Th>
              <Th className="pr-3" variant="compact">
                Model
              </Th>
              <Th className="pr-3" variant="compact">
                Skills
              </Th>
              <Th className="pr-3" variant="compact">
                Tools
              </Th>
              <Th className="pr-3" variant="compact">
                Scope
              </Th>
              <Th className="pr-3" variant="compact">
                Ver
              </Th>
              <Th className="pr-3" variant="compact">
                Verified
              </Th>
              <Th className="pr-3" variant="compact">
                Origin
              </Th>
              <Th variant="compact" />
            </THead>
            <tbody>
              {(agents ?? []).length === 0 ? (
                <TableStatusRow colSpan={10}>
                  <EmptyState title="No GLOBAL agents yet." />
                </TableStatusRow>
              ) : (
                (agents ?? []).map((a) => (
                  <TRow key={a.id}>
                    <Td className="py-3 pr-3 font-mono text-[11px] text-paper-200">{a.key}</Td>
                    <Td className="py-3 pr-3">
                      <span className="text-paper-100">{a.name}</span>
                      {a.description && (
                        <div className="mt-0.5 max-w-[180px] truncate text-[11px] text-paper-500">
                          {a.description}
                        </div>
                      )}
                    </Td>
                    <Td className="py-3 pr-3 font-mono text-[11px] text-paper-400">
                      {modelLabel(a)}
                    </Td>
                    <Td className="py-3 pr-3 text-paper-400">
                      {a.skillRefs.length > 0 ? (
                        <span className="font-mono text-[11px]">{a.skillRefs.length}</span>
                      ) : (
                        <span className="text-paper-600">—</span>
                      )}
                    </Td>
                    <Td className="py-3 pr-3 font-mono text-[11px] text-paper-400">
                      {toolKeysLabel(a.toolKeys)}
                    </Td>
                    <Td className="py-3 pr-3">
                      <Badge tone="muted" uppercase variant="text">
                        {a.scope === 'ORGANIZATION' && a.orgId
                          ? `ORG:${a.orgId.slice(0, 8)}`
                          : a.scope}
                      </Badge>
                    </Td>
                    <Td className="py-3 pr-3 tabular-nums text-paper-400">v{a.version}</Td>
                    <Td className="py-3 pr-3">
                      <Badge tone={a.isVerified ? 'moss' : 'muted'} variant="text">
                        {a.isVerified ? '✓' : '—'}
                      </Badge>
                    </Td>
                    <Td className="py-3 pr-3">
                      <Badge tone="muted" uppercase variant="text">
                        {a.origin ?? 'custom'}
                      </Badge>
                    </Td>
                    <Td className="py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button onClick={() => openEdit(a)} size="sm" variant="ghost">
                          Edit
                        </Button>
                        <Button onClick={() => setDeleting(a)} size="sm" variant="danger">
                          Deactivate
                        </Button>
                      </div>
                    </Td>
                  </TRow>
                ))
              )}
            </tbody>
          </Table>
        </QueryBoundary>
      </Card>

      {/* ── Create ── */}
      <Modal onClose={() => setCreateOpen(false)} open={createOpen} size="lg" title="New agent">
        <AgentFormFields
          copy={CREATE_COPY}
          credentials={credentials ?? []}
          mcpConnections={mcpConnections ?? []}
          mode="create"
          onChange={(patch) => setCreateForm({ ...createForm, ...patch })}
          scopeFields={
            <div className="grid grid-cols-2 gap-4">
              <Select
                hint="GLOBAL is visible system-wide; ORGANIZATION pins to a single org; CHANNEL pins to a Slack channel"
                label="Scope"
                onChange={(e) => {
                  const scope = e.target.value as CreateAgentBody['scope'];
                  setCreateForm({
                    ...createForm,
                    channelId: scope !== 'CHANNEL' ? undefined : createForm.channelId,
                    orgId: scope !== 'ORGANIZATION' ? undefined : createForm.orgId,
                    scope,
                  });
                }}
                value={createForm.scope}
              >
                <option value="GLOBAL">GLOBAL</option>
                <option value="ORGANIZATION">ORGANIZATION</option>
                <option value="TEAM">TEAM</option>
                <option value="CHANNEL">CHANNEL</option>
                <option value="WORKFLOW_TEMPLATE">WORKFLOW_TEMPLATE</option>
              </Select>
              {createForm.scope === 'ORGANIZATION' && (
                <Input
                  hint="UUID of the owning organization"
                  label="Organization ID"
                  onChange={(e) =>
                    setCreateForm({ ...createForm, orgId: e.target.value || undefined })
                  }
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  value={createForm.orgId ?? ''}
                />
              )}
              {createForm.scope === 'CHANNEL' && (
                <Select
                  hint="Slack channel this agent override applies to"
                  label="Channel"
                  onChange={(e) =>
                    setCreateForm({ ...createForm, channelId: e.target.value || undefined })
                  }
                  value={createForm.channelId ?? ''}
                >
                  <option value="">Select a channel…</option>
                  {(slackChannels ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name ?? c.slackChannelId}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          }
          skillEditorLabel="Skills"
          skillEmptyHint="No skills available."
          skills={skills ?? []}
          toolKeysInheritHint="Agent inherits all available tools"
          value={createForm}
        />
        {createError && <Alert variant="error">{createError}</Alert>}
        <ModalFooter
          disabled={
            !createForm.key ||
            !createForm.name ||
            (createForm.scope === 'CHANNEL' && !createForm.channelId)
          }
          isPending={createAgent.isPending}
          onCancel={() => setCreateOpen(false)}
          onSubmit={submitCreate}
          pendingLabel="Creating…"
          submitLabel="Create agent"
        />
      </Modal>

      {/* ── Edit ── */}
      <Modal
        onClose={() => setEditing(null)}
        open={editing !== null}
        size="lg"
        subtitle={editing ? `${editing.key} · v${editing.version} → v${editing.version + 1}` : ''}
        title="Edit agent"
      >
        {editing ? (
          <>
            <AgentFormFields
              copy={EDIT_COPY}
              credentials={credentials ?? []}
              mcpConnections={mcpConnections ?? []}
              mode="edit"
              onChange={patchEditing}
              skillEditorLabel="Skills"
              skillEmptyHint="No skills available."
              skills={skills ?? []}
              toolKeysInheritHint="Agent inherits all available tools"
              value={{
                ...editing,
                skillRefs: (editing.skillRefs ?? []).map((r) => ({
                  skillId: r.skillId,
                  sortOrder: r.sortOrder,
                })),
              }}
            />
            {editError && <Alert variant="error">{editError}</Alert>}
            <ModalFooter
              isPending={updateAgent.isPending}
              onCancel={() => setEditing(null)}
              onSubmit={submitEdit}
              pendingLabel="Saving…"
              submitLabel="Save new version"
            />
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
        pendingLabel="Deactivating…"
        title="Deactivate agent"
      />
    </div>
  );
}
