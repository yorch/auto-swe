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
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type AgentRow,
  type AgentSaveWarnings,
  type AgentSkillRef,
  type CreateTeamAgentBody,
  type SkillRefInput,
  type UpdateAgentBody,
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

const CREATE_COPY: AgentFormCopy = {
  inheritsModelFrom: { hint: 'Agent whose model this one uses' },
  key: { hint: 'Global agent key to override (e.g. reviewer) or a new custom key' },
  mcpConnection: { hint: "Bind this MCP server's tools at run time" },
  modelSpec: { hint: '<provider>/<model>, or blank to inherit' },
  systemPrompt: { hint: 'Leave blank to inherit the global prompt' },
};

const EDIT_COPY: AgentFormCopy = {
  systemPrompt: { hint: 'Leave blank to inherit the global prompt' },
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
    if (!editing) {
      return;
    }
    setEditError(null);
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
          mcpConnectionId: editing.mcpConnectionId ?? null,
          skillRefs: skillRefsPayload,
          toolKeys: editing.toolKeys,
        },
        id: editing.id,
      });
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
        <CardTitle eyebrow="Team scope">Agent overrides</CardTitle>
        {(agents ?? []).length > 0 && (
          <Button onClick={openCreate} size="sm" variant="secondary">
            <Icon name="plus" size={14} />
            New override
          </Button>
        )}
      </CardHeader>
      <p className="mb-4 text-[13px] text-paper-400">
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
        loading={<SkeletonRows rows={2} />}
        onRetry={() => void refetch()}
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
          <Table stacked>
            <THead>
              <Th className="pl-0" variant="plain">
                Agent
              </Th>
              <Th variant="plain">Model</Th>
              <Th align="right" variant="plain">
                Skills
              </Th>
              <Th variant="plain">Version</Th>
              <Th className="pr-0" variant="plain">
                <span className="sr-only">Actions</span>
              </Th>
            </THead>
            <tbody>
              {(agents ?? []).map((a) => (
                <TRow hover key={a.id}>
                  <Td className="py-3 pr-4" primary>
                    <div className="truncate font-medium text-paper-100">{a.name || a.key}</div>
                    <div className="truncate font-mono text-xs font-normal text-paper-500">
                      {a.key}
                    </div>
                  </Td>
                  <Td className="px-4 py-3" label="Model">
                    <span className="font-mono text-xs break-all text-paper-300">
                      {modelLabel(a)}
                    </span>
                  </Td>
                  <Td align="right" className="px-4 py-3 text-xs tabular-nums" label="Skills">
                    {a.skillRefs.length > 0 ? (
                      <span className="text-paper-300">{a.skillRefs.length}</span>
                    ) : (
                      <span className="text-paper-500">None</span>
                    )}
                  </Td>
                  <Td className="px-4 py-3" label="Version">
                    <Badge className="tabular-nums" tone="neutral" variant="outline">
                      v{a.version}
                    </Badge>
                  </Td>
                  <Td align="right" className="py-3 pl-4">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        aria-label={`Edit ${a.key}`}
                        onClick={() => {
                          setSaveWarnings({});
                          setEditError(null);
                          setEditing({ ...a });
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
                    </div>
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
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
