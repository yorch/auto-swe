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
import { Combobox } from '@/components/ui/Combobox';
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
  type AgentScope,
  type AgentSkillRef,
  type CreateAgentBody,
  type SkillRefInput,
  useAgentLibrary,
  useCreateAgent,
  useDeleteAgent,
  useUpdateAgent,
} from '@/hooks/useAgentLibrary';
import { useMcpConnections } from '@/hooks/useMcpConnections';
import { useAdminCredentials } from '@/hooks/useModelConfig';
import { useSkills } from '@/hooks/useSkills';
import { useSlackChannels } from '@/hooks/useSlackChannels';
import { useTeams } from '@/hooks/useTeams';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { modelLabel } from '@/lib/agentDisplay';
import { buildAgentUpdate } from '@/lib/agentEditPatch';
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

const SCOPES: readonly AgentScope[] = [
  'GLOBAL',
  'ORGANIZATION',
  'TEAM',
  'CHANNEL',
  'WORKFLOW_TEMPLATE',
];

/** The target a scoped row is pinned to, named where the page can resolve it. */
function scopeTarget(
  a: AgentRow,
  names: {
    teams: Map<string, string>;
    templates: Map<string, string>;
    channels: Map<string, string>;
  }
): string | null {
  if (a.teamId) {
    return names.teams.get(a.teamId) ?? a.teamId.slice(0, 8);
  }
  if (a.workflowTemplateId) {
    return names.templates.get(a.workflowTemplateId) ?? a.workflowTemplateId.slice(0, 8);
  }
  if (a.channelId) {
    return names.channels.get(a.channelId) ?? a.channelId.slice(0, 8);
  }
  if (a.orgId) {
    return a.orgId.slice(0, 8);
  }
  return null;
}

export default function AgentLibraryPage() {
  // Every scope: filtering to GLOBAL hid organization, team, channel and
  // template overrides from the only page that manages them.
  const { data: agents, error: loadError, isError, isLoading } = useAgentLibrary();
  const { data: teams } = useTeams();
  const { data: templates } = useWorkflowTemplates();
  const [scopeFilter, setScopeFilter] = useState<'' | AgentScope>('');
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
  // The row as loaded, so a save sends only what changed.
  const [editingOriginal, setEditingOriginal] = useState<AgentRow | null>(null);
  const [deleting, setDeleting] = useState<AgentRow | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [catalogWarnings, setCatalogWarnings] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  async function submitCreate() {
    setCreateError(null);
    setWarnings([]);
    setCatalogWarnings([]);
    try {
      const res = await createAgent.mutateAsync(
        cleanAgentPayload({ ...createForm }) as CreateAgentBody
      );
      setWarnings(res.scanWarnings ?? []);
      setCatalogWarnings(res.catalogWarnings ?? []);
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE);
    } catch (e) {
      setCreateError(errMsg(e, 'Create failed'));
    }
  }

  async function submitEdit() {
    if (!(editing && editingOriginal)) {
      return;
    }
    setEditError(null);
    setWarnings([]);
    setCatalogWarnings([]);
    if (!editing.name.trim()) {
      setEditError('Name is required');
      return;
    }
    const body = buildAgentUpdate(editingOriginal, editing);
    if (Object.keys(body).length === 0) {
      closeEdit();
      return;
    }
    try {
      const res = await updateAgent.mutateAsync({ body, id: editing.id });
      setWarnings(res.scanWarnings ?? []);
      setCatalogWarnings(res.catalogWarnings ?? []);
      closeEdit();
    } catch (e) {
      setEditError(errMsg(e, 'Update failed'));
    }
  }

  function openEdit(a: AgentRow) {
    setEditError(null);
    setEditing({ ...a });
    setEditingOriginal(a);
  }

  function closeEdit() {
    setEditing(null);
    setEditingOriginal(null);
    setEditError(null);
  }

  const names = {
    channels: new Map((slackChannels ?? []).map((c) => [c.id, c.name ?? c.slackChannelId])),
    teams: new Map((teams ?? []).map((t) => [t.id, t.name])),
    templates: new Map((templates ?? []).map((t) => [t.id, t.name])),
  };
  const visibleAgents = (agents ?? []).filter((a) => !scopeFilter || a.scope === scopeFilter);
  const createScopeIncomplete =
    (createForm.scope === 'ORGANIZATION' && !createForm.orgId) ||
    (createForm.scope === 'TEAM' && !createForm.teamId) ||
    (createForm.scope === 'CHANNEL' && !createForm.channelId) ||
    (createForm.scope === 'WORKFLOW_TEMPLATE' && !createForm.workflowTemplateId);

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
      {catalogWarnings.length > 0 ? (
        <Alert variant="warning">Model catalog: {catalogWarnings.join(' ')}</Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle eyebrow={scopeFilter ? `${scopeFilter} scope` : 'All scopes'}>
            Agents
          </CardTitle>
          <Select
            aria-label="Filter by scope"
            className="h-9 w-auto px-2 font-mono text-xs"
            onChange={(v) => setScopeFilter(v as '' | AgentScope)}
            options={[
              { label: 'All scopes', value: '' },
              ...SCOPES.map((sc) => ({ label: sc, value: sc })),
            ]}
            value={scopeFilter}
          />
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
              {visibleAgents.length === 0 ? (
                <TableStatusRow colSpan={10}>
                  <EmptyState title="No agents in this scope." />
                </TableStatusRow>
              ) : (
                visibleAgents.map((a) => (
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
                        {a.scope}
                      </Badge>
                      {scopeTarget(a, names) && (
                        <div className="mt-0.5 text-[11px] text-paper-400">
                          {scopeTarget(a, names)}
                        </div>
                      )}
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
                hint="GLOBAL is visible system-wide; the other scopes pin the override to one organization, team, Slack channel or workflow template"
                label="Scope"
                onChange={(v) => {
                  const scope = v as CreateAgentBody['scope'];
                  setCreateForm({
                    ...createForm,
                    channelId: scope !== 'CHANNEL' ? undefined : createForm.channelId,
                    orgId: scope !== 'ORGANIZATION' ? undefined : createForm.orgId,
                    scope,
                    teamId: scope !== 'TEAM' ? undefined : createForm.teamId,
                    workflowTemplateId:
                      scope !== 'WORKFLOW_TEMPLATE' ? undefined : createForm.workflowTemplateId,
                  });
                }}
                options={[
                  { label: 'GLOBAL', value: 'GLOBAL' },
                  { label: 'ORGANIZATION', value: 'ORGANIZATION' },
                  { label: 'TEAM', value: 'TEAM' },
                  { label: 'CHANNEL', value: 'CHANNEL' },
                  { label: 'WORKFLOW_TEMPLATE', value: 'WORKFLOW_TEMPLATE' },
                ]}
                value={createForm.scope}
              />
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
              {createForm.scope === 'TEAM' && (
                <Combobox
                  label="Team"
                  onChange={(v) => setCreateForm({ ...createForm, teamId: v || undefined })}
                  options={(teams ?? []).map((t) => ({ label: t.name, value: t.id }))}
                  placeholder="Select a team…"
                  value={createForm.teamId ?? ''}
                />
              )}
              {createForm.scope === 'WORKFLOW_TEMPLATE' && (
                <Combobox
                  label="Workflow template"
                  onChange={(v) =>
                    setCreateForm({
                      ...createForm,
                      workflowTemplateId: v || undefined,
                    })
                  }
                  options={(templates ?? []).map((t) => ({ label: t.name, value: t.id }))}
                  placeholder="Select a template…"
                  value={createForm.workflowTemplateId ?? ''}
                />
              )}
              {createForm.scope === 'CHANNEL' && (
                <Combobox
                  hint="Slack channel this agent override applies to"
                  label="Channel"
                  onChange={(v) => setCreateForm({ ...createForm, channelId: v || undefined })}
                  options={(slackChannels ?? []).map((c) => ({
                    label: c.name ?? c.slackChannelId,
                    value: c.id,
                  }))}
                  placeholder="Select a channel…"
                  value={createForm.channelId ?? ''}
                />
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
          disabled={!createForm.key || !createForm.name || createScopeIncomplete}
          isPending={createAgent.isPending}
          onCancel={() => setCreateOpen(false)}
          onSubmit={submitCreate}
          pendingLabel="Creating…"
          submitLabel="Create agent"
        />
      </Modal>

      {/* ── Edit ── */}
      <Modal
        onClose={closeEdit}
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
              onCancel={closeEdit}
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
