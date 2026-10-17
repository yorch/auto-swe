'use client';

import { useState } from 'react';
import { cleanAgentPayload } from '@/components/agents/AgentEditorFields';
import {
  type AgentFormCopy,
  AgentFormFields,
  type AgentFormValue,
} from '@/components/agents/AgentFormFields';
import { ModelSaveWarnings } from '@/components/agents/ModelSaveWarnings';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type AgentRow,
  type AgentSaveWarnings,
  type AgentSkillRef,
  type CreateTeamAgentBody,
  type SkillRefInput,
  useCreateTeamAgent,
  useDeleteTeamAgent,
  useTeamAgentOptions,
  useTeamAgents,
  useUpdateTeamAgent,
} from '@/hooks/useAgentLibrary';
import { useHasRole } from '@/hooks/useHasRole';
import { useMcpConnections } from '@/hooks/useMcpConnections';
import { useTeamSkills } from '@/hooks/useSkills';
import { modelLabel } from '@/lib/agentDisplay';
import { buildAgentUpdate } from '@/lib/agentEditPatch';
import { errMsg } from '@/lib/errors';
import { scanWarningLead } from '@/lib/scanWarnings';

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

/**
 * A blank prompt resolves to the agent's built-in default, not to the
 * platform-wide row's prompt: the override replaces that row, field for field.
 */
export const OVERRIDE_PROMPT_HINT =
  "Leave blank to use the agent's built-in default prompt. The platform-wide agent's prompt is not carried over; copy it here to build on it.";

const CREATE_COPY: AgentFormCopy = {
  inheritsModelFrom: { hint: 'Agent whose model this one uses' },
  key: { hint: 'Global agent key to override (e.g. reviewer) or a new custom key' },
  mcpConnection: { hint: "Bind this MCP server's tools at run time" },
  modelSpec: {
    hint: "<provider>/<model>. Required — or choose Inherit to use another agent's model.",
  },
  systemPrompt: { hint: OVERRIDE_PROMPT_HINT },
};

const EDIT_COPY: AgentFormCopy = {
  modelSpec: {
    hint: "<provider>/<model>. Required — or choose Inherit to use another agent's model.",
  },
  systemPrompt: { hint: OVERRIDE_PROMPT_HINT },
};

/**
 * Team-owner editor for TEAM-scope Agents — per-team overrides of the GLOBAL
 * library, resolved by `resolveAgent` ahead of GLOBAL for this team's runs.
 */
export function TeamAgentLibrarySection({ teamId }: { teamId: string }) {
  const {
    data: agents,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useTeamAgents(teamId);
  const createAgent = useCreateTeamAgent(teamId);
  const updateAgent = useUpdateTeamAgent(teamId);
  const deleteAgent = useDeleteTeamAgent(teamId);
  // The platform MCP connection list is ADMIN-only; a team ADMIN who is not a
  // platform ADMIN gets no picker (and no request that can only 403). The
  // skill picker reads the team-scoped list, which any team member may read.
  const isPlatformAdmin = useHasRole('ADMIN');
  const { data: mcpConnections } = useMcpConnections({ enabled: isPlatformAdmin });
  const { data: skills } = useTeamSkills(teamId);
  const { data: parentAgents } = useTeamAgentOptions(teamId);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateTeamAgentBody>(EMPTY);
  const [editing, setEditing] = useState<AgentRow | null>(null);
  // The row as it was when the edit opened, so a save sends only what changed.
  const [editingOriginal, setEditingOriginal] = useState<AgentRow | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<AgentRow | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  // Advisories from the last save. The override is live; these only say what to check.
  const [saveWarnings, setSaveWarnings] = useState<AgentSaveWarnings>({});

  const hasSaveWarnings =
    (saveWarnings.scanWarnings?.length ?? 0) > 0 ||
    (saveWarnings.catalogWarnings?.length ?? 0) > 0 ||
    (saveWarnings.credentialWarnings?.length ?? 0) > 0 ||
    (saveWarnings.runtimeWarnings?.length ?? 0) > 0;

  async function submitCreate() {
    setCreateError(null);
    try {
      setSaveWarnings(
        await createAgent.mutateAsync(cleanAgentPayload({ ...form }) as CreateTeamAgentBody)
      );
      setCreateOpen(false);
      setForm(EMPTY);
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
    // Only what changed, as the platform library sends it: an unchanged prompt
    // resent would be rescanned and lose its verification.
    const body = buildAgentUpdate(editingOriginal, editing);
    if (Object.keys(body).length === 0) {
      setEditing(null);
      return;
    }
    try {
      const res = await updateAgent.mutateAsync({ body, id: editing.id });
      setSaveWarnings(res);
      setEditing(null);
    } catch (e) {
      setEditError(errMsg(e, 'Update failed'));
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
    setSaveWarnings({});
    setCreateError(null);
    setCreateOpen(true);
  };

  return (
    <Card className="p-4 sm:p-6">
      <CardHeader className="mb-1">
        <CardTitle>Agent overrides</CardTitle>
        {(agents ?? []).length > 0 && (
          <Button onClick={openCreate} size="sm" variant="secondary">
            <Icon name="plus" size={14} />
            New override
          </Button>
        )}
      </CardHeader>
      <p className="mb-4 text-sm text-paper-400">
        Per-team agents override the global library for this team's runs. Leave a field blank to
        inherit the global value.
      </p>

      {hasSaveWarnings && (
        <div className="mb-4 space-y-2">
          {(saveWarnings.scanWarnings?.length ?? 0) > 0 && (
            <Alert variant="warning">
              {scanWarningLead(saveWarnings.scanWarnings ?? [])}{' '}
              {saveWarnings.scanWarnings?.join('; ')}
            </Alert>
          )}
          <ModelSaveWarnings
            catalogWarnings={saveWarnings.catalogWarnings}
            credentialWarnings={saveWarnings.credentialWarnings}
            runtimeWarnings={saveWarnings.runtimeWarnings}
          />
        </div>
      )}

      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="team agents"
        onRetry={() => void refetch()}
        rows={2}
      >
        {(agents ?? []).length === 0 ? (
          <EmptyState
            action={
              <Button onClick={openCreate} size="sm" variant="secondary">
                <Icon name="plus" size={14} />
                New override
              </Button>
            }
            className="py-6"
            hint="Override a global agent's model, prompt or skills for this team only."
            icon="agents"
            title="No team overrides yet"
          />
        ) : (
          <DataTable
            actions={(a) => (
              <>
                <Button
                  aria-label={`Edit ${a.key}`}
                  onClick={() => {
                    setSaveWarnings({});
                    setEditError(null);
                    setEditing({ ...a });
                    setEditingOriginal(a);
                  }}
                  size="sm"
                  variant="secondary"
                >
                  Edit
                </Button>
                <ActionMenu
                  items={[
                    {
                      icon: 'trash',
                      id: 'delete',
                      label: 'Delete override',
                      onAction: () => setDeleteConfirm(a),
                      tone: 'danger',
                    },
                  ]}
                  label={`More actions for ${a.key}`}
                />
              </>
            )}
            columns={[
              {
                cell: (a) => a.name || a.key,
                header: 'Agent',
                id: 'agent',
                primary: true,
                secondary: (a) => <span className="font-mono">{a.key}</span>,
              },
              {
                cell: (a) => (
                  <span className="font-mono text-xs break-all text-paper-300">
                    {modelLabel(a)}
                  </span>
                ),
                header: 'Model',
                id: 'model',
              },
              {
                align: 'right',
                cell: (a) =>
                  a.skillRefs.length > 0 ? (
                    <span className="tabular text-xs text-paper-300">{a.skillRefs.length}</span>
                  ) : (
                    <span className="text-xs text-paper-500">None</span>
                  ),
                header: 'Skills',
                id: 'skills',
              },
              {
                cell: (a) => (
                  <Badge className="tabular-nums" tone="neutral" variant="outline">
                    v{a.version}
                  </Badge>
                ),
                header: 'Version',
                id: 'version',
              },
            ]}
            getRowId={(a) => a.id}
            revealActions={false}
            rows={agents ?? []}
          />
        )}
      </QueryBoundary>

      {/* Create */}
      <Modal
        onClose={() => setCreateOpen(false)}
        open={createOpen}
        size="lg"
        title="New team agent"
      >
        <AgentFormFields
          copy={CREATE_COPY}
          mcpConnections={mcpConnections ?? []}
          mode="create"
          onChange={(patch) => setForm({ ...form, ...patch })}
          parentAgents={parentAgents}
          skills={skills ?? []}
          value={form}
        />
        {createError && <Alert variant="error">{createError}</Alert>}
        <ModalFooter
          disabled={!form.key || !form.name}
          isPending={createAgent.isPending}
          onCancel={() => setCreateOpen(false)}
          onSubmit={submitCreate}
          pendingLabel="Creating…"
          submitLabel="Create agent"
        />
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
            <AgentFormFields
              copy={EDIT_COPY}
              mcpConnections={mcpConnections ?? []}
              mode="edit"
              onChange={patchEditing}
              parentAgents={parentAgents}
              skills={skills ?? []}
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

      {/* Delete confirmation */}
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message={`Deactivate ${deleteConfirm?.key ?? 'this agent'} for this team? The global agent is unaffected — this team's runs fall back to the global version.`}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={async () => {
          if (deleteConfirm) {
            await deleteAgent.mutateAsync(deleteConfirm.id);
          }
        }}
        open={deleteConfirm !== null}
        pendingLabel="Deleting…"
        title="Delete team agent?"
      />
    </Card>
  );
}
