'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { AddMemberModal } from '@/components/teams/AddMemberModal';
import { EgressAllowlistEditor } from '@/components/teams/EgressAllowlistEditor';
import { ShellAllowlistEditor } from '@/components/teams/ShellAllowlistEditor';
import { TeamAgentLibrarySection } from '@/components/teams/TeamAgentLibrarySection';
import { TeamFormModal } from '@/components/teams/TeamFormModal';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Table } from '@/components/ui/Table';
import { Textarea } from '@/components/ui/Textarea';
import { useRemoveTeamMember, useTeam, useUpdateTeam, useUpdateTeamMember } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';
import { isRole } from '@/lib/roles';
import { validateRouteParam } from '@/lib/routeParams';
import { teamPermissions } from '@/lib/teamPermissions';
import { useAuthStore } from '@/stores/authStore';

export default function TeamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const { data: team, isLoading, isError, error: loadError } = useTeam(id ?? '');
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
  const [memberError, setMemberError] = useState<string | null>(null);

  const updateTeam = useUpdateTeam(id ?? '');

  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmRemoveEmail, setConfirmRemoveEmail] = useState<string | null>(null);
  const [personaInput, setPersonaInput] = useState('');
  const [personaError, setPersonaError] = useState<string | null>(null);

  if (!id) {
    return <div className="text-center py-12 text-paper-400">Team not found</div>;
  }

  async function handleSavePersona() {
    setPersonaError(null);
    try {
      await updateTeam.mutateAsync({ defaultPersonaPrompt: personaInput.trim() || null });
      setPersonaInput('');
    } catch (e) {
      setPersonaError(errMsg(e, 'Failed to update persona'));
    }
  }

  if (isLoading) {
    return <LoadingState />;
  }
  if (isError) {
    return (
      <Alert variant="error">Could not load team: {errMsg(loadError, 'request failed')}</Alert>
    );
  }
  if (!team) {
    return <div className="text-center py-12 text-paper-400">Team not found</div>;
  }

  const memberships = team.memberships ?? [];
  const existingUserIds = memberships.map((m) => m.user?.id ?? '').filter(Boolean);

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <>
            <Link className="text-ember-400 hover:underline text-sm" href="/govern/teams">
              &larr; Teams
            </Link>
            {canManage && (
              <Button onClick={() => setEditing(true)} size="sm" variant="ghost">
                Edit team
              </Button>
            )}
          </>
        }
        chapter="§ Teams"
        title={team.name}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Members ({memberships.length})</CardTitle>
            {canManage && (
              <Button onClick={() => setAdding(true)} size="sm" variant="primary">
                + Add
              </Button>
            )}
          </CardHeader>
          {memberError && (
            <Alert className="mb-3" variant="error">
              {memberError}
            </Alert>
          )}
          <Table>
            <thead>
              <tr className="border-b border-ink-600">
                <th className="text-left py-2">Email</th>
                <th className="text-left py-2">Platform Role</th>
                <th className="text-left py-2">Team Role</th>
                {canManage && <th className="py-2" />}
              </tr>
            </thead>
            <tbody>
              {memberships.map((m) => (
                <tr className="border-b border-ink-600" key={m.id}>
                  <td className="py-2">{m.user?.email}</td>
                  <td className="py-2 text-paper-400">{m.user?.role}</td>
                  <td className="py-2">
                    {canManage &&
                    m.user?.id &&
                    isRole(m.role) &&
                    grantableRoles.includes(m.role) ? (
                      <Select
                        aria-label={`Team role for ${m.user.email ?? 'member'}`}
                        className="h-7 w-auto px-2 text-xs"
                        disabled={updateMember.isPending}
                        onChange={(e) => {
                          const role = e.target.value;
                          const memberId = m.user?.id;
                          if (memberId && isRole(role)) {
                            setMemberError(null);
                            updateMember.mutate(
                              { role, userId: memberId },
                              {
                                onError: (err) =>
                                  setMemberError(errMsg(err, 'Failed to change the member role')),
                              }
                            );
                          }
                        }}
                        value={m.role}
                      >
                        {grantableRoles.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      m.role
                    )}
                  </td>
                  {canManage && (
                    <td className="py-2 text-right">
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
                    </td>
                  )}
                </tr>
              ))}
              {memberships.length === 0 && (
                <tr>
                  <td
                    className="py-4 text-center text-xs text-paper-500"
                    colSpan={canManage ? 4 : 3}
                  >
                    No members yet.
                  </td>
                </tr>
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
                <span className={`text-xs ${r.isActive ? 'text-moss-400' : 'text-paper-400'}`}>
                  {r.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
            ))}
            {(team.repositories ?? []).length === 0 && (
              <p className="py-4 text-center text-xs text-paper-500">
                No repositories yet. Add one from{' '}
                <Link className="text-ember-400 hover:underline" href="/connections">
                  Connections
                </Link>
                .
              </p>
            )}
          </div>
        </Card>
      </div>

      {canEditAllowlists && <ShellAllowlistEditor teamId={id} />}
      {canEditAllowlists && <EgressAllowlistEditor teamId={id} />}
      {canManageTeamAgents && <TeamAgentLibrarySection teamId={id} />}

      {/* The persona is a field on the team itself: PATCH /teams/:id, team LEAD. */}
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle eyebrow="Channel Assistant">Default Persona</CardTitle>
          </CardHeader>
          <div className="space-y-4">
            {personaError ? <Alert variant="error">{personaError}</Alert> : null}
            <div>
              <p className="text-sm text-paper-500">Current default persona</p>
              {team.defaultPersonaPrompt ? (
                <p className="mt-1 whitespace-pre-wrap text-sm text-paper-100">
                  {team.defaultPersonaPrompt}
                </p>
              ) : (
                <p className="mt-1 text-sm text-paper-500 italic">None set</p>
              )}
            </div>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Textarea
                  hint="Team-wide default persona for all channel assistants. Channels can override this individually. Leave blank to clear."
                  label="New persona"
                  onChange={(e) => setPersonaInput(e.target.value)}
                  placeholder="You are a helpful assistant for this team…"
                  value={personaInput}
                />
              </div>
              <Button disabled={updateTeam.isPending} onClick={handleSavePersona} variant="primary">
                {team.defaultPersonaPrompt ? 'Update' : 'Set'}
              </Button>
            </div>
            {team.defaultPersonaPrompt && (
              <Button
                disabled={updateTeam.isPending}
                onClick={() => {
                  setPersonaInput('');
                  setPersonaError(null);
                  updateTeam.mutate(
                    { defaultPersonaPrompt: null },
                    { onError: (err) => setPersonaError(errMsg(err, 'Failed to clear persona')) }
                  );
                }}
                variant="ghost"
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
          // Awaited so ConfirmModal keeps the dialog open and shows a failure.
          if (confirmRemoveId) {
            await removeMember.mutateAsync(confirmRemoveId);
          }
        }}
        open={confirmRemoveId !== null}
        title="Remove member"
      />
    </div>
  );
}
