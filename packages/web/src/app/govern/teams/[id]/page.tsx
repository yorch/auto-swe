'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { AddMemberModal } from '@/components/teams/AddMemberModal';
import { EgressAllowlistEditor } from '@/components/teams/EgressAllowlistEditor';
import { ShellAllowlistEditor } from '@/components/teams/ShellAllowlistEditor';
import { TeamAgentLibrarySection } from '@/components/teams/TeamAgentLibrarySection';
import { TeamFormModal } from '@/components/teams/TeamFormModal';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { Textarea } from '@/components/ui/Textarea';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { useRemoveTeamMember, useTeam, useUpdateTeam, useUpdateTeamMember } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';
import { isRole } from '@/lib/roles';
import { validateRouteParam } from '@/lib/routeParams';
import { teamPermissions } from '@/lib/teamPermissions';
import { useAuthStore } from '@/stores/authStore';

const SUBTITLE = 'Members, repositories, sandbox allowlists and agent overrides for one team.';

function BackLink() {
  return (
    <Link className="label-mono hover:text-paper-200" href="/govern/teams">
      ← Teams
    </Link>
  );
}

/** Header-only frame for the branches that have no team to show. */
function TeamFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-8">
      <BackLink />
      <PageHeader chapter="§ Govern" subtitle={SUBTITLE} title="Team" />
      {children}
    </div>
  );
}

function TeamNotFound() {
  return (
    <TeamFrame>
      <EmptyState
        action={<ButtonLink href="/govern/teams">Back to teams</ButtonLink>}
        title="Team not found"
      />
    </TeamFrame>
  );
}

export default function TeamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const { data: team, error, isError, isFetching, refetch, isLoading } = useTeam(id ?? '');
  const updateMember = useUpdateTeamMember(id ?? '');
  const removeMember = useRemoveTeamMember(id ?? '');
  const platformRole = useAuthStore((s) => s.user?.role);
  const userId = useAuthStore((s) => s.user?.sub ?? null);
  // Offer only what the gateway will accept from this caller on this team, so
  // no control renders that 403s on use — see teamPermissions for the rules.
  const ownTeamRole = team?.memberships?.find((m) => m.user?.id === userId)?.role;
  const {
    canManageMembers: canManage,
    grantableRoles,
    canEditAllowlists,
    canManageTeamAgents,
  } = teamPermissions(platformRole, ownTeamRole);
  const updateTeam = useUpdateTeam(id ?? '');

  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmRemoveEmail, setConfirmRemoveEmail] = useState<string | null>(null);
  const [personaInput, setPersonaInput] = usePrefilledField(team?.defaultPersonaPrompt);
  const [personaError, setPersonaError] = useState<string | null>(null);
  const [confirmClearPersona, setConfirmClearPersona] = useState(false);
  const [memberError, setMemberError] = useState<string | null>(null);

  if (!id) {
    return <TeamNotFound />;
  }

  async function handleSavePersona() {
    setPersonaError(null);
    const next = personaInput.trim();
    // Save never clears: emptying the text is not a deliberate delete, so it
    // is refused and the confirmed "Clear persona" action is the only way.
    if (!next) {
      setPersonaError('Enter a persona to save, or use "Clear persona" to remove the current one.');
      return;
    }
    try {
      await updateTeam.mutateAsync({ defaultPersonaPrompt: next });
    } catch (e) {
      setPersonaError(errMsg(e, 'Failed to update persona'));
    }
  }

  if (isLoading || isError) {
    return (
      <TeamFrame>
        <QueryBoundary
          error={error}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="team"
          onRetry={() => void refetch()}
        />
      </TeamFrame>
    );
  }
  if (!team) {
    return <TeamNotFound />;
  }

  const personaUnchanged = personaInput.trim() === (team.defaultPersonaPrompt ?? '').trim();
  const memberships = team.memberships ?? [];
  const existingUserIds = memberships.map((m) => m.user?.id ?? '').filter(Boolean);

  return (
    <div className="space-y-8">
      <BackLink />
      <PageHeader
        actions={
          canManage && (
            <Button onClick={() => setEditing(true)} size="sm" variant="ghost">
              Edit team
            </Button>
          )
        }
        chapter="§ Govern"
        subtitle={team.description || SUBTITLE}
        title={team.name}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Members ({memberships.length})</CardTitle>
            {canManage && (
              <Button onClick={() => setAdding(true)} size="sm" variant="primary">
                Add member
              </Button>
            )}
          </CardHeader>
          {memberError && <Alert variant="error">{memberError}</Alert>}
          <Table>
            <THead>
              <Th className="pr-3" variant="compact">
                Email
              </Th>
              <Th className="pr-3" variant="compact">
                Platform role
              </Th>
              <Th className="pr-3" variant="compact">
                Team role
              </Th>
              {canManage && <Th variant="compact" />}
            </THead>
            <tbody>
              {memberships.map((m) => (
                <TRow key={m.id}>
                  <Td className="py-2 pr-3">{m.user?.email}</Td>
                  <Td className="py-2 pr-3 text-paper-400">{m.user?.role}</Td>
                  <Td className="py-2 pr-3">
                    {canManage &&
                    m.user?.id &&
                    isRole(m.role) &&
                    grantableRoles.includes(m.role) ? (
                      <Select
                        aria-label={`Team role for ${m.user.email ?? 'member'}`}
                        className="w-auto"
                        compact
                        disabled={updateMember.isPending}
                        onChange={(role) => {
                          const memberId = m.user?.id;
                          if (memberId && isRole(role)) {
                            setMemberError(null);
                            updateMember
                              .mutateAsync({ role, userId: memberId })
                              .catch((err) =>
                                setMemberError(errMsg(err, 'Failed to change the member role'))
                              );
                          }
                        }}
                        options={grantableRoles.map((r) => ({ label: r, value: r }))}
                        value={m.role}
                      />
                    ) : (
                      m.role
                    )}
                  </Td>
                  {canManage && (
                    <Td align="right" className="py-2">
                      {m.user?.id && (
                        <Button
                          disabled={removeMember.isPending}
                          onClick={() => {
                            if (m.user?.id) {
                              setConfirmRemoveId(m.user.id);
                              setConfirmRemoveEmail(m.user.email ?? null);
                            }
                          }}
                          size="sm"
                          variant="danger"
                        >
                          Remove
                        </Button>
                      )}
                    </Td>
                  )}
                </TRow>
              ))}
              {memberships.length === 0 && (
                <TableStatusRow colSpan={canManage ? 4 : 3}>
                  <EmptyState className="py-4" title="No members yet." />
                </TableStatusRow>
              )}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Repositories ({team.repositories?.length ?? 0})</CardTitle>
          </CardHeader>
          <div className="space-y-2">
            {(team.repositories ?? []).map((r) => (
              <div
                className="flex items-center justify-between text-sm p-2 rounded hover:bg-ink-800"
                key={r.id}
              >
                <span className="font-medium">
                  {r.organizationName}/{r.repoName}
                </span>
                <Badge tone={r.isActive ? 'moss' : 'neutral'} variant="text">
                  {r.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </div>
            ))}
            {(team.repositories ?? []).length === 0 && (
              <EmptyState
                className="py-4"
                hint={
                  <>
                    Add one from{' '}
                    <Link className="text-ember-400 hover:underline" href="/connections">
                      Connections
                    </Link>
                    .
                  </>
                }
                title="No repositories yet."
              />
            )}
          </div>
        </Card>

        {(team.sharedRepositories ?? []).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Shared with this team ({team.sharedRepositories.length})</CardTitle>
            </CardHeader>
            <div className="space-y-2">
              {team.sharedRepositories.map((r) => (
                <div
                  className="flex items-center justify-between text-sm p-2 rounded hover:bg-ink-800"
                  key={r.id}
                >
                  <span className="font-medium">
                    {r.organizationName}/{r.repoName}
                  </span>
                  <span className="text-paper-500">shared by {r.team.name}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {canEditAllowlists && <ShellAllowlistEditor teamId={id} />}
      {canEditAllowlists && <EgressAllowlistEditor teamId={id} />}
      {canManageTeamAgents && <TeamAgentLibrarySection teamId={id} />}

      {/* The persona is a field on the team itself: PATCH /teams/:id, team LEAD. */}
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle eyebrow="Channel assistant">Default persona</CardTitle>
          </CardHeader>
          <div className="space-y-4">
            {personaError ? <Alert variant="error">{personaError}</Alert> : null}
            {!team.defaultPersonaPrompt && (
              <p className="text-sm text-paper-500 italic">No default persona set.</p>
            )}
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Textarea
                  hint="Team-wide default persona for all channel assistants. Channels can override this individually."
                  label="Persona"
                  onChange={(e) => setPersonaInput(e.target.value)}
                  placeholder="You are a helpful assistant for this team…"
                  value={personaInput}
                />
              </div>
              <Button
                disabled={updateTeam.isPending || personaUnchanged}
                onClick={handleSavePersona}
                variant="primary"
              >
                {updateTeam.isPending ? 'Saving…' : 'Save persona'}
              </Button>
            </div>
            {team.defaultPersonaPrompt && (
              <Button
                disabled={updateTeam.isPending}
                onClick={() => setConfirmClearPersona(true)}
                size="sm"
                variant="danger"
              >
                Clear persona
              </Button>
            )}
          </div>
        </Card>
      )}

      <TeamFormModal
        mode={{
          initial: { description: team.description, name: team.name },
          kind: 'edit',
          teamId: id,
        }}
        onClose={() => setEditing(false)}
        open={editing}
      />
      <AddMemberModal
        existingUserIds={existingUserIds}
        grantableRoles={grantableRoles}
        onClose={() => setAdding(false)}
        open={adding}
        teamId={id}
      />
      <ConfirmModal
        confirmLabel="Remove"
        dangerous
        message={`Remove ${confirmRemoveEmail ?? 'this user'} from ${team.name}?`}
        onClose={() => {
          setConfirmRemoveId(null);
          setConfirmRemoveEmail(null);
        }}
        onConfirm={async () => {
          if (confirmRemoveId) {
            await removeMember.mutateAsync(confirmRemoveId);
          }
        }}
        open={confirmRemoveId !== null}
        title="Remove member"
      />
      <ConfirmModal
        confirmLabel="Clear"
        dangerous
        message="The team-wide default persona is removed; channels that set their own persona are unaffected. The current text is not kept."
        onClose={() => setConfirmClearPersona(false)}
        onConfirm={async () => {
          await updateTeam.mutateAsync({ defaultPersonaPrompt: null });
        }}
        open={confirmClearPersona}
        title="Clear persona?"
      />
    </div>
  );
}
