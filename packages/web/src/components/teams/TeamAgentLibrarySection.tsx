'use client';

import { useState } from 'react';
import { cleanAgentPayload } from '@/components/agents/AgentEditorFields';
import {
  type AgentFormCopy,
  AgentFormFields,
  type AgentFormValue,
} from '@/components/agents/AgentFormFields';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type AgentRow,
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
  key: { hint: 'GLOBAL key to override (e.g. reviewer) or a new custom key' },
  mcpConnection: { hint: "Bind this MCP server's tools at run time" },
  modelSpec: { hint: '<provider>/<model>, or blank to inherit' },
  systemPrompt: { hint: 'Leave blank to inherit the GLOBAL prompt' },
};

const EDIT_COPY: AgentFormCopy = {
  systemPrompt: { hint: 'Leave blank to inherit the GLOBAL prompt' },
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

  async function submitCreate() {
    setCreateError(null);
    try {
      await createAgent.mutateAsync(cleanAgentPayload({ ...form }) as CreateTeamAgentBody);
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

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="TEAM scope">Agent overrides</CardTitle>
        <Button
          onClick={() => {
            setCreateError(null);
            setCreateOpen(true);
          }}
          size="sm"
          variant="primary"
        >
          New override
        </Button>
      </CardHeader>
      <p className="mb-3 text-xs text-paper-400">
        Per-team Agents override the GLOBAL library for this team's runs. Leave a field blank to
        inherit from GLOBAL.
      </p>

      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="team agents"
        onRetry={() => void refetch()}
      >
        {(agents ?? []).length === 0 ? (
          <EmptyState className="py-3" title="No team overrides yet." />
        ) : (
          <Table>
            <THead>
              <Th className="pr-3" variant="compact">
                Key
              </Th>
              <Th className="pr-3" variant="compact">
                Model
              </Th>
              <Th className="pr-3" variant="compact">
                Skills
              </Th>
              <Th className="pr-3" variant="compact">
                Ver
              </Th>
              <Th variant="compact" />
            </THead>
            <tbody>
              {(agents ?? []).map((a) => (
                <TRow key={a.id}>
                  <Td className="py-2 pr-3 font-mono text-[11px] text-paper-200">{a.key}</Td>
                  <Td className="py-2 pr-3 font-mono text-[11px] text-paper-400">
                    {modelLabel(a)}
                  </Td>
                  <Td className="py-2 pr-3 font-mono text-[11px] text-paper-400">
                    {a.skillRefs.length > 0 ? a.skillRefs.length : '—'}
                  </Td>
                  <Td className="py-2 pr-3 tabular-nums text-paper-400">v{a.version}</Td>
                  <Td className="py-2">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        onClick={() => {
                          setEditError(null);
                          setEditing({ ...a });
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        Edit
                      </Button>
                      <Button onClick={() => setDeleteConfirm(a)} size="sm" variant="danger">
                        Delete
                      </Button>
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
        message={`Deactivate ${deleteConfirm?.key ?? 'this agent'} for this team? GLOBAL agents are unaffected — runs will fall through to the GLOBAL version.`}
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
