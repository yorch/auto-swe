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
import { broaderFallbacks } from '@/components/agents/agentFallback';
import { ModelSaveWarnings } from '@/components/agents/ModelSaveWarnings';
import { SetupBanner } from '@/components/setup/SetupReadiness';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { useOrganizationDirectory } from '@/hooks/useAdmin';
import {
  type AgentRow,
  type AgentSaveWarnings,
  type AgentScope,
  type AgentSkillRef,
  type CreateAgentBody,
  type SkillRefInput,
  useAgentLibrary,
  useCreateAgent,
  useDeleteAgent,
  useUpdateAgent,
} from '@/hooks/useAgentLibrary';
import { useHasRole } from '@/hooks/useHasRole';
import { useMcpConnections } from '@/hooks/useMcpConnections';
import { useAdminCredentials } from '@/hooks/useModelConfig';
import { useReadiness } from '@/hooks/useReadiness';
import { useSkills } from '@/hooks/useSkills';
import { useSlackChannels } from '@/hooks/useSlackChannels';
import { useTeams } from '@/hooks/useTeams';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import {
  missingCredentialProvider,
  modelLabel,
  SCOPE_ORDER,
  scopeLabel,
  toolKeysLabel,
} from '@/lib/agentDisplay';
import { buildAgentUpdate } from '@/lib/agentEditPatch';
import { errMsg } from '@/lib/errors';
import { originLabel } from '@/lib/originLabel';

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

const SCOPE_NOUN: Record<AgentScope, string> = {
  CHANNEL: 'Slack channel',
  GLOBAL: 'deployment',
  ORGANIZATION: 'organization',
  TEAM: 'team',
  WORKFLOW_TEMPLATE: 'workflow template',
};
const scopeNoun = (scope: AgentScope) => SCOPE_NOUN[scope];

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

/** What a save leaves to read: the saved agent is live; the scanner and catalog only advise. */
interface SavedNotice {
  title: string;
  scanWarnings: string[];
  catalogWarnings: string[];
  credentialWarnings: string[];
  /** Harness agents that inherit the newly saved model and cannot run on it. */
  runtimeWarnings: string[];
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
  // Readiness already knows which providers lack a credential, so one request covers every row.
  const isAdmin = useHasRole('ADMIN');
  const { data: readiness } = useReadiness(isAdmin);
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

  function finishSave(title: string, res: AgentSaveWarnings & { runtimeWarnings?: string[] }) {
    const scanWarnings = res.scanWarnings ?? [];
    const catalogWarnings = res.catalogWarnings ?? [];
    const credentialWarnings = res.credentialWarnings ?? [];
    const runtimeWarnings = res.runtimeWarnings ?? [];
    setSaved(
      scanWarnings.length > 0 ||
        catalogWarnings.length > 0 ||
        credentialWarnings.length > 0 ||
        runtimeWarnings.length > 0
        ? { catalogWarnings, credentialWarnings, runtimeWarnings, scanWarnings, title }
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
  // Each key's overrides sit directly under its GLOBAL row, and keys are ordered by that row's
  // display name, since the name is what the first column shows.
  const keyNames = new Map<string, string>();
  for (const a of agents ?? []) {
    if (a.scope === 'GLOBAL' || !keyNames.has(a.key)) {
      keyNames.set(a.key, a.name);
    }
  }
  const visibleAgents = (agents ?? [])
    .filter((a) => !scopeFilter || a.scope === scopeFilter)
    .filter(
      (a) => !query || `${a.key} ${a.name} ${a.description ?? ''}`.toLowerCase().includes(query)
    )
    .sort(
      (a, b) =>
        (keyNames.get(a.key) ?? a.name).localeCompare(keyNames.get(b.key) ?? b.name) ||
        a.key.localeCompare(b.key) ||
        SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope)
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

  const openCreate = () => {
    setCreateError(null);
    setCreateOpen(true);
  };

  const rowActions = (a: AgentRow) => (
    <div className="flex items-center justify-end gap-1">
      <Button
        aria-label={`Edit ${a.key}`}
        onClick={() => openEdit(a)}
        size="sm"
        variant="secondary"
      >
        Edit
      </Button>
      <ActionMenu
        items={[
          {
            icon: 'clock',
            id: 'history',
            label: 'Version history',
            onAction: () => setHistory(a),
          },
          {
            icon: 'trash',
            id: 'deactivate',
            label: 'Deactivate',
            onAction: () => setDeleting(a),
            tone: 'danger',
          },
        ]}
        label={`More actions for ${a.key}`}
      />
    </div>
  );

  const scopeCounts = new Map<AgentScope, number>();
  for (const a of agents ?? []) {
    scopeCounts.set(a.scope, (scopeCounts.get(a.scope) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={openCreate} variant="primary">
            <Icon name="plus" size={14} />
            New agent
          </Button>
        }
        subtitle="Versioned agents. Saving an edit creates a new version; runs already in progress keep the version they started with, and History lets you compare or restore any version."
        title="Agent library"
      />
      <SetupBanner items={['credentials']} />

      <Card className="p-4 sm:p-6">
        <Toolbar
          end={
            agents && agents.length > 0 ? (
              <span className="text-xs text-paper-500 tabular-nums">
                {filtering
                  ? `${visibleAgents.length} of ${agents.length} agents`
                  : `${agents.length} agents`}
              </span>
            ) : null
          }
        >
          <SearchInput
            label="Search agents"
            onChange={setTextFilter}
            placeholder="Search agents…"
            value={textFilter}
          />
          <Select
            aria-label="Filter by scope"
            className="h-8 w-full text-[13px] sm:w-44"
            onChange={(v) => setScopeFilter(v as '' | AgentScope)}
            options={[
              { label: 'All scopes', value: '' },
              ...SCOPE_ORDER.map((sc) => ({
                label: scopeCounts.has(sc)
                  ? `${scopeLabel(sc)} (${scopeCounts.get(sc)})`
                  : scopeLabel(sc),
                value: sc,
              })),
            ]}
            value={scopeFilter}
          />
          {filtering && (
            <Button
              onClick={() => {
                setTextFilter('');
                setScopeFilter('');
              }}
              size="sm"
              variant="ghost"
            >
              Clear filters
            </Button>
          )}
        </Toolbar>
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="agents"
          loading={<SkeletonRows rows={8} />}
          onRetry={() => void refetch()}
        >
          {visibleAgents.length === 0 ? (
            filtering ? (
              <EmptyState
                action={
                  <Button
                    onClick={() => {
                      setTextFilter('');
                      setScopeFilter('');
                    }}
                    size="sm"
                  >
                    Clear filters
                  </Button>
                }
                hint="Try a different search or scope."
                icon="search"
                title="No agents match these filters"
              />
            ) : (
              <EmptyState
                action={
                  <Button onClick={openCreate} size="sm" variant="primary">
                    New agent
                  </Button>
                }
                hint="An agent pairs a model with a prompt, skills and tools. Workflow steps call agents by key."
                icon="agents"
                title="No agents yet"
              />
            )
          ) : (
            <Table stacked>
              <THead>
                <Th className="pl-0" variant="plain">
                  Agent
                </Th>
                <Th variant="plain">Model</Th>
                <Th variant="plain">Scope</Th>
                <Th variant="plain">Skills and tools</Th>
                <Th variant="plain">Version</Th>
                <Th className="pr-0" variant="plain">
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <tbody>
                {visibleAgents.map((a, i) => {
                  const sameKeyAsAbove = i > 0 && visibleAgents[i - 1].key === a.key;
                  const missingProvider = missingCredentialProvider(
                    a,
                    agents ?? [],
                    readiness?.providers ?? []
                  );
                  const target = scopeTarget(a, names);
                  const tools = toolKeysLabel(a.toolKeys);
                  return (
                    <TRow hover key={a.id}>
                      <Td className="py-3 pr-4 align-top sm:max-w-[22rem]" primary>
                        <div className="flex min-w-0 items-baseline gap-2">
                          {sameKeyAsAbove && (
                            <span aria-hidden className="text-paper-600">
                              ↳
                            </span>
                          )}
                          <span className="truncate font-medium text-paper-100">{a.name}</span>
                          <span className="truncate font-mono text-xs text-paper-500">{a.key}</span>
                        </div>
                        {sameKeyAsAbove ? (
                          <div className="mt-0.5 text-xs text-paper-500">
                            Override of {keyNames.get(a.key) ?? a.key}
                          </div>
                        ) : (
                          a.description && (
                            <div
                              className="mt-0.5 line-clamp-1 text-xs text-paper-500"
                              title={a.description}
                            >
                              {a.description}
                            </div>
                          )
                        )}
                      </Td>
                      <Td className="px-4 py-3 align-top" label="Model">
                        {a.modelSpec ? (
                          <span className="font-mono text-xs break-all text-paper-300">
                            {a.modelSpec}
                          </span>
                        ) : a.inheritsModelFrom ? (
                          <span className="text-xs text-paper-400">
                            Inherits{' '}
                            <span className="font-mono text-paper-300">{a.inheritsModelFrom}</span>
                          </span>
                        ) : (
                          <span className="text-xs text-paper-500">{modelLabel(a)}</span>
                        )}
                        <div className="mt-1 flex flex-wrap gap-1 max-sm:justify-end">
                          {missingProvider ? (
                            <Badge
                              dot
                              title={`No ${missingProvider} credential. Runs that use this agent fail at their first model call. Add one under Model configuration.`}
                              tone="brick"
                            >
                              No credential
                            </Badge>
                          ) : a.credentialId ? (
                            <Badge title="Pinned to a specific provider credential" tone="neutral">
                              {credentialNames.get(a.credentialId) ?? 'Pinned credential'}
                            </Badge>
                          ) : null}
                        </div>
                      </Td>
                      <Td className="px-4 py-3 align-top" label="Scope">
                        <Badge tone={a.scope === 'GLOBAL' ? 'neutral' : 'dust'}>
                          {scopeLabel(a.scope)}
                        </Badge>
                        {target && (
                          <div className="mt-1 truncate text-xs text-paper-400">{target}</div>
                        )}
                      </Td>
                      <Td className="px-4 py-3 align-top text-xs" label="Skills and tools">
                        <div className="text-paper-300">
                          {a.skillRefs.length > 0
                            ? `${a.skillRefs.length} ${a.skillRefs.length === 1 ? 'skill' : 'skills'}`
                            : 'No skills'}
                        </div>
                        <div className="mt-0.5 truncate text-paper-500 sm:max-w-48" title={tools}>
                          {a.toolKeys && a.toolKeys.length > 0
                            ? `${a.toolKeys.length} ${a.toolKeys.length === 1 ? 'tool' : 'tools'}`
                            : tools}
                        </div>
                      </Td>
                      <Td className="px-4 py-3 align-top" label="Version">
                        <div className="flex flex-wrap items-center gap-1 max-sm:justify-end">
                          <Badge className="tabular-nums" tone="neutral" variant="outline">
                            v{a.version}
                          </Badge>
                          <Badge
                            title={originLabel(a.origin)}
                            tone={a.isVerified ? 'moss' : 'amber'}
                          >
                            {a.isVerified ? 'Verified' : 'Unverified'}
                          </Badge>
                        </div>
                        <div className="mt-1 text-xs text-paper-500">{originLabel(a.origin)}</div>
                      </Td>
                      <Td align="right" className="py-3 pl-4 align-top">
                        {rowActions(a)}
                      </Td>
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
          showRuntime
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
              showRuntime
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
            <ModelSaveWarnings
              catalogWarnings={saved.catalogWarnings}
              credentialWarnings={saved.credentialWarnings}
            />
            {saved.runtimeWarnings.length > 0 && (
              <Alert variant="warning">
                Saved, but agents on the Claude Code harness inherit this model, which the harness
                cannot drive. Their runs fail until they get an Anthropic model of their own or move
                to the Mastra loop:
                <ul className="mt-1 list-disc pl-5">
                  {saved.runtimeWarnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Alert>
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
        confirmText={deleting?.scope === 'GLOBAL' ? deleting.key : undefined}
        dangerous
        message={
          deleting ? (
            deleting.scope === 'GLOBAL' ? (
              <div className="space-y-2">
                <p>
                  Deactivate all versions of <strong>{deleting.key}</strong>? Nothing sits behind
                  the global version, so runs that need <code>{deleting.key}</code> will fail.
                </p>
                <p>
                  If this agent is required, the worker will also refuse to start until it is active
                  again.
                </p>
              </div>
            ) : (
              (() => {
                const fallbacks = broaderFallbacks(deleting, agents ?? []);
                return fallbacks.length > 0
                  ? `Deactivate all versions of '${deleting.key}' for this ${scopeNoun(deleting.scope)}? Runs there fall back to the ${scopeNoun(fallbacks[0] as AgentScope)} version of this agent.`
                  : `Deactivate all versions of '${deleting.key}' for this ${scopeNoun(deleting.scope)}? No broader version exists, so runs there that need this agent will fail.`;
              })()
            )
          ) : (
            ''
          )
        }
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) {
            await deleteAgent.mutateAsync({
              force: deleting.scope === 'GLOBAL',
              id: deleting.id,
            });
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
