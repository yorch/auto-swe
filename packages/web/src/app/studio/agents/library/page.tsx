'use client';

import { useState } from 'react';
import { cleanAgentPayload } from '@/components/agents/AgentEditorFields';
import {
  type AgentFormCopy,
  AgentFormFields,
  type AgentFormValue,
} from '@/components/agents/AgentFormFields';
import { AgentHistoryModal } from '@/components/agents/AgentHistoryModal';
import { AgentScopeFields } from '@/components/agents/AgentScopeFields';
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
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useOrganizationDirectory } from '@/hooks/useAdmin';
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
import { modelLabel, SCOPE_ORDER, scopeLabel, toolKeysLabel } from '@/lib/agentDisplay';
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

const SKILLS_HINT = 'Ordered list of skills injected into the system prompt';

const CREATE_COPY: AgentFormCopy = {
  credential: { hint: 'Use a specific provider credential instead of the system default' },
  description: {
    hint: 'Short summary shown in the agent table',
    placeholder: 'Reviews pull-request diffs for correctness',
  },
  inheritsModelFrom: { hint: 'The agent whose model this one uses', placeholder: 'reviewer' },
  key: { placeholder: 'codeReviewer' },
  mcpConnection: {
    hint: "The agent can call this server's tools when it runs. The 'mcp' tool is ticked for you if the tool list is custom.",
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
  mcpConnection: {
    hint: "The agent can call this server's tools. The 'mcp' tool is ticked for you if the tool list is custom.",
  },
  modelSpec: { hint: 'Leave blank to inherit from the role default' },
  skills: { hint: SKILLS_HINT },
  systemPrompt: { hint: 'A change here resets verification and triggers a content scan.' },
};

// ── Page ──────────────────────────────────────────────────────────────────────

/** The target a scoped row is pinned to, named where the page can resolve it. */
function scopeTarget(
  a: AgentRow,
  names: {
    teams: Map<string, string>;
    templates: Map<string, string>;
    channels: Map<string, string>;
    orgs: Map<string, string>;
  }
): string | null {
  if (a.teamId) {
    return names.teams.get(a.teamId) ?? 'A team';
  }
  if (a.workflowTemplateId) {
    return names.templates.get(a.workflowTemplateId) ?? 'A workflow';
  }
  if (a.channelId) {
    return names.channels.get(a.channelId) ?? 'A channel';
  }
  if (a.orgId) {
    return names.orgs.get(a.orgId) ?? 'An organization';
  }
  return null;
}

/** Plain-language provenance for the origin column. */
function originLabel(origin: string | null): string {
  if (!origin) {
    return 'Custom';
  }
  return origin === 'swe-starter' ? 'Engineering starter' : origin;
}

/** What a save leaves to read: the saved agent is live; the scanner and catalog only advise. */
interface SavedNotice {
  title: string;
  scanWarnings: string[];
  catalogWarnings: string[];
}

export default function AgentLibraryPage() {
  // Every scope: filtering to GLOBAL hid organization, team, channel and
  // template overrides from the only page that manages them.
  const {
    data: agents,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useAgentLibrary();
  const { data: teams } = useTeams();
  const { data: templates } = useWorkflowTemplates();
  const { data: orgs } = useOrganizationDirectory();
  const [scopeFilter, setScopeFilter] = useState<'' | AgentScope>('');
  const [textFilter, setTextFilter] = useState('');
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
  const [history, setHistory] = useState<AgentRow | null>(null);
  // Set after a save the scanner or catalog commented on: the agent exists, and the dialog stays
  // open only so the findings are read rather than vanishing with the form.
  const [saved, setSaved] = useState<SavedNotice | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  function finishSave(title: string, res: { scanWarnings?: string[]; catalogWarnings?: string[] }) {
    const scanWarnings = res.scanWarnings ?? [];
    const catalogWarnings = res.catalogWarnings ?? [];
    setSaved(
      scanWarnings.length > 0 || catalogWarnings.length > 0
        ? { catalogWarnings, scanWarnings, title }
        : null
    );
  }

  async function submitCreate() {
    setCreateError(null);
    try {
      const res = await createAgent.mutateAsync(
        cleanAgentPayload({ ...createForm }) as CreateAgentBody
      );
      finishSave('Agent created', res);
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
      finishSave('New version saved', res);
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
    orgs: new Map((orgs ?? []).map((o) => [o.id, o.name])),
    teams: new Map((teams ?? []).map((t) => [t.id, t.name])),
    templates: new Map((templates ?? []).map((t) => [t.id, t.name])),
  };
  const mcpNames = new Map((mcpConnections ?? []).map((c) => [c.id, c.name ?? 'Unnamed server']));
  const credentialNames = new Map(
    (credentials ?? []).map((c) => [c.id, `${c.provider} ···${c.lastFour}`])
  );
  const query = textFilter.trim().toLowerCase();
  // Sorted by key so an agent and its narrower-scope overrides sit together.
  const visibleAgents = (agents ?? [])
    .filter((a) => !scopeFilter || a.scope === scopeFilter)
    .filter(
      (a) => !query || `${a.key} ${a.name} ${a.description ?? ''}`.toLowerCase().includes(query)
    )
    .sort(
      (a, b) =>
        a.key.localeCompare(b.key) || SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope)
    );
  const filtering = Boolean(scopeFilter || query);
  // Agents a sub-role can borrow a model from: those with a model of their own.
  const parentAgents = (agents ?? [])
    .filter((a) => a.scope === 'GLOBAL' && a.isActive && a.modelSpec)
    .map((a) => ({ key: a.key, modelSpec: a.modelSpec, name: a.name }));
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

  const rowActions = (a: AgentRow) => (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <Button onClick={() => setHistory(a)} size="sm" variant="ghost">
        History
      </Button>
      <Button onClick={() => openEdit(a)} size="sm" variant="ghost">
        Edit
      </Button>
      <Button onClick={() => setDeleting(a)} size="sm" variant="danger">
        Deactivate
      </Button>
    </div>
  );

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
        subtitle="Versioned agents. Saving an edit creates a new version; runs already in progress keep the version they started with, and History lets you compare or restore any version."
        title="Agent library"
      />

      <Card>
        <CardHeader>
          <CardTitle eyebrow={scopeFilter ? scopeLabel(scopeFilter) : 'All scopes'}>
            Agents
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Search agents"
              className="h-9 w-48"
              onChange={(e) => setTextFilter(e.target.value)}
              placeholder="Search agents…"
              type="search"
              value={textFilter}
            />
            <Select
              aria-label="Filter by scope"
              className="h-9 w-auto px-2 text-xs"
              onChange={(v) => setScopeFilter(v as '' | AgentScope)}
              options={[
                { label: 'All scopes', value: '' },
                ...SCOPE_ORDER.map((sc) => ({ label: scopeLabel(sc), value: sc })),
              ]}
              value={scopeFilter}
            />
          </div>
        </CardHeader>
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="agents"
          onRetry={() => void refetch()}
        >
          {visibleAgents.length === 0 ? (
            <EmptyState
              hint={
                filtering
                  ? 'Try a different search or scope.'
                  : 'Create one with the New agent button.'
              }
              title={filtering ? 'No agents match these filters.' : 'No agents yet.'}
            />
          ) : (
            <Table stacked>
              <THead>
                <Th className="pr-3" variant="compact">
                  Agent
                </Th>
                <Th className="pr-3" variant="compact">
                  Model
                </Th>
                <Th className="pr-3" variant="compact">
                  Applies to
                </Th>
                <Th className="pr-3" variant="compact">
                  Skills and tools
                </Th>
                <Th className="pr-3" variant="compact">
                  Version
                </Th>
                <Th variant="compact" />
              </THead>
              <tbody>
                {visibleAgents.map((a, i) => {
                  const sameKeyAsAbove = i > 0 && visibleAgents[i - 1].key === a.key;
                  return (
                    <TRow key={a.id}>
                      <Td className="py-3 pr-3" primary>
                        <span className="text-paper-100">{a.name}</span>
                        <div className="mt-0.5 font-mono text-[11px] text-paper-500">
                          {sameKeyAsAbove ? `↳ override of ${a.key}` : a.key}
                        </div>
                        {a.description && (
                          <div className="mt-0.5 max-w-[220px] truncate text-[11px] text-paper-500">
                            {a.description}
                          </div>
                        )}
                      </Td>
                      <Td className="py-3 pr-3 font-mono text-[11px] text-paper-400" label="Model">
                        {modelLabel(a)}
                      </Td>
                      <Td className="py-3 pr-3" label="Applies to">
                        <Badge tone="muted" variant="text">
                          {scopeLabel(a.scope)}
                        </Badge>
                        {scopeTarget(a, names) && (
                          <div className="mt-0.5 text-[11px] text-paper-400">
                            {scopeTarget(a, names)}
                          </div>
                        )}
                      </Td>
                      <Td className="py-3 pr-3 text-xs text-paper-400" label="Skills and tools">
                        {a.skillRefs.length > 0
                          ? `${a.skillRefs.length} ${a.skillRefs.length === 1 ? 'skill' : 'skills'}`
                          : 'No skills'}
                        <div className="text-paper-500">{toolKeysLabel(a.toolKeys)}</div>
                      </Td>
                      <Td className="py-3 pr-3 text-xs text-paper-400" label="Version">
                        <span className="tabular-nums">v{a.version}</span>
                        <div>
                          <Badge tone={a.isVerified ? 'moss' : 'muted'} variant="text">
                            {a.isVerified ? 'Verified' : 'Unverified'}
                          </Badge>
                        </div>
                        <div className="text-paper-500">{originLabel(a.origin)}</div>
                      </Td>
                      <Td className="py-3">{rowActions(a)}</Td>
                    </TRow>
                  );
                })}
              </tbody>
            </Table>
          )}
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
          parentAgents={parentAgents}
          scopeFields={
            <AgentScopeFields
              channels={(slackChannels ?? []).map((c) => ({
                id: c.id,
                name: c.name ?? c.slackChannelId,
              }))}
              form={createForm}
              onChange={setCreateForm}
              orgs={orgs ?? []}
              teams={teams ?? []}
              templates={templates ?? []}
            />
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
              parentAgents={parentAgents}
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

      {/* ── Saved, with the scanner's and catalog's findings ── */}
      <Modal onClose={() => setSaved(null)} open={saved !== null} title={saved?.title ?? 'Saved'}>
        {saved && (
          <div className="space-y-4">
            {saved.scanWarnings.length > 0 && (
              <Alert variant="warning">
                Saved, but the content scanner flagged the prompt. Review it before relying on the
                agent:
                <ul className="mt-1 list-disc pl-5">
                  {saved.scanWarnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {saved.catalogWarnings.length > 0 && (
              <Alert variant="warning">Model catalog: {saved.catalogWarnings.join(' ')}</Alert>
            )}
            <div className="flex justify-end">
              <Button onClick={() => setSaved(null)} variant="primary">
                Done
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {history && (
        <AgentHistoryModal
          agent={history}
          credentialNames={credentialNames}
          mcpNames={mcpNames}
          onClose={() => setHistory(null)}
        />
      )}

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
