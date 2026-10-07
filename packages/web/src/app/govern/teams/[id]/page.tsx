'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { AddMemberModal } from '@/components/teams/AddMemberModal';
import { EgressAllowlistEditor } from '@/components/teams/EgressAllowlistEditor';
import { ShellAllowlistEditor } from '@/components/teams/ShellAllowlistEditor';
import { TeamAgentLibrarySection } from '@/components/teams/TeamAgentLibrarySection';
import { TeamFormModal } from '@/components/teams/TeamFormModal';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { BackLink } from '@/components/ui/BackLink';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { Textarea } from '@/components/ui/Textarea';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { useRemoveTeamMember, useTeam, useUpdateTeam, useUpdateTeamMember } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';
import { platformRoleLabel } from '@/lib/govLabels';
import { isRole } from '@/lib/roles';
import { validateRouteParam } from '@/lib/routeParams';
import { teamPermissions } from '@/lib/teamPermissions';
import { plural } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

const SUBTITLE = 'Members, repositories, sandbox allowlists and agent overrides for one team.';

/** Header-only frame for the branches that have no team to show. */
function TeamFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <BackLink href="/govern/teams" label="Teams" />
      <PageHeader subtitle={SUBTITLE} title="Team" />
      {children}
    </div>
  );
}

/** One repository line in the side rail: `org/repo` and a trailing note or badge. */
function RepoLine({ name, trailing }: { name: string; trailing: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="shrink-0 text-paper-500" name="repositories" size={14} />
        <span className="truncate font-mono text-[13px] text-paper-200" title={name}>
          {name}
        </span>
      </span>
      <span className="shrink-0">{trailing}</span>
    </li>
  );
}

function TeamNotFound() {
  return (
    <TeamFrame>
      <EmptyState
        action={<ButtonLink href="/govern/teams">Back to teams</ButtonLink>}
        bordered
        hint="It may have been deleted, or the link is wrong."
        icon="teams"
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

  const repositories = team.repositories ?? [];
  const shared = team.sharedRepositories ?? [];

  return (
    <div className="space-y-6">
      <BackLink href="/govern/teams" label="Teams" />
      <PageHeader
        actions={
          canManage && (
            <Button onClick={() => setEditing(true)} variant="secondary">
              <Icon name="edit" size={14} />
              Edit team
            </Button>
          )
        }
        subtitle={
          <>
            {team.description || SUBTITLE}
            <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-paper-500">
              <span className="font-mono">{team.slug}</span>
              <span>{plural(memberships.length, 'member')}</span>
              <span>{plural(repositories.length, 'repo')}</span>
            </span>
          </>
        }
        title={team.name}
      />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="p-4 sm:p-6">
          <CardHeader>
            <CardTitle>Members</CardTitle>
            {canManage && memberships.length > 0 && (
              <Button onClick={() => setAdding(true)} size="sm" variant="primary">
                <Icon name="plus" size={14} />
                Add member
              </Button>
            )}
          </CardHeader>
          {memberError && (
            <Alert className="mb-3" variant="error">
              {memberError}
            </Alert>
          )}
          {memberships.length === 0 ? (
            <EmptyState
              action={
                canManage && (
                  <Button onClick={() => setAdding(true)} size="sm" variant="primary">
                    <Icon name="plus" size={14} />
                    Add member
                  </Button>
                )
              }
              hint="Members can run work against this team's repositories."
              icon="users"
              title="No members yet"
            />
          ) : (
            <Table stacked>
              <THead>
                <Th className="pl-0" variant="plain">
                  Member
                </Th>
                <Th variant="plain">Team role</Th>
                {canManage && (
                  <Th className="pr-0" variant="plain">
                    <span className="sr-only">Actions</span>
                  </Th>
                )}
              </THead>
              <tbody>
                {memberships.map((m) => (
                  <TRow hover key={m.id}>
                    <Td className="py-3 pr-4" primary>
                      <div className="truncate font-medium text-paper-100">{m.user?.email}</div>
                      <div className="mt-0.5 text-xs font-normal text-paper-500">
                        Platform role: {platformRoleLabel(m.user?.role ?? '')}
                      </div>
                    </Td>
                    <Td className="px-4 py-3" label="Team role">
                      {canManage &&
                      m.user?.id &&
                      isRole(m.role) &&
                      grantableRoles.includes(m.role) ? (
                        <Select
                          aria-label={`Team role for ${m.user.email ?? 'member'}`}
                          className="w-32"
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
                          options={grantableRoles.map((r) => ({
                            label: platformRoleLabel(r),
                            value: r,
                          }))}
                          value={m.role}
                        />
                      ) : (
                        <Badge tone="neutral" variant="outline">
                          {platformRoleLabel(m.role)}
                        </Badge>
                      )}
                    </Td>
                    {canManage && (
                      <Td align="right" className="py-3 pl-4">
                        {m.user?.id && (
                          <ActionMenu
                            items={[
                              {
                                disabled: removeMember.isPending,
                                icon: 'trash',
                                id: 'remove',
                                label: 'Remove from team',
                                onAction: () => {
                                  if (m.user?.id) {
                                    setConfirmRemoveId(m.user.id);
                                    setConfirmRemoveEmail(m.user.email ?? null);
                                  }
                                },
                                tone: 'danger',
                              },
                            ]}
                            label={`More actions for ${m.user.email ?? 'member'}`}
                          />
                        )}
                      </Td>
                    )}
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader className="mb-2">
              <CardTitle>Repositories</CardTitle>
              <span className="text-xs text-paper-500 tabular-nums">{repositories.length}</span>
            </CardHeader>
            {repositories.length === 0 ? (
              <EmptyState
                className="py-6"
                hint={
                  <>
                    Add one from{' '}
                    <Link className="text-ember-400 hover:underline" href="/connections">
                      Connections
                    </Link>
                    .
                  </>
                }
                icon="repositories"
                title="No repositories yet"
              />
            ) : (
              <ul className="divide-y divide-ink-600">
                {repositories.map((r) => (
                  <RepoLine
                    key={r.id}
                    name={`${r.organizationName}/${r.repoName}`}
                    trailing={
                      <Badge dot tone={r.isActive ? 'moss' : 'muted'} variant="text">
                        {r.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    }
                  />
                ))}
              </ul>
            )}
          </Card>

          {shared.length > 0 && (
            <Card>
              <CardHeader className="mb-2">
                <CardTitle>Shared with this team</CardTitle>
                <span className="text-xs text-paper-500 tabular-nums">{shared.length}</span>
              </CardHeader>
              <ul className="divide-y divide-ink-600">
                {shared.map((r) => (
                  <RepoLine
                    key={r.id}
                    name={`${r.organizationName}/${r.repoName}`}
                    trailing={<span className="text-xs text-paper-500">from {r.team.name}</span>}
                  />
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {canManage && (
        <Card>
          <CardHeader className="mb-1">
            <CardTitle eyebrow="Channel assistant">Default persona</CardTitle>
            {!team.defaultPersonaPrompt && (
              <Badge tone="muted" variant="outline">
                Not set
              </Badge>
            )}
          </CardHeader>
          <p className="mb-4 text-[13px] text-paper-400">
            Team-wide default persona for every channel assistant. A channel can override it.
          </p>
          <div className="space-y-4">
            {personaError ? <Alert variant="error">{personaError}</Alert> : null}
            <Textarea
              className="font-sans text-sm"
              label="Persona"
              onChange={(e) => setPersonaInput(e.target.value)}
              placeholder="You are a helpful assistant for this team…"
              value={personaInput}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
              {team.defaultPersonaPrompt && (
                <Button
                  disabled={updateTeam.isPending}
                  onClick={() => setConfirmClearPersona(true)}
                  variant="ghost"
                >
                  Clear persona
                </Button>
              )}
              <Button
                disabled={updateTeam.isPending || personaUnchanged}
                onClick={handleSavePersona}
                variant="primary"
              >
                {updateTeam.isPending ? 'Saving…' : 'Save persona'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {canManageTeamAgents && <TeamAgentLibrarySection teamId={id} />}
      {canEditAllowlists && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ShellAllowlistEditor teamId={id} />
          <EgressAllowlistEditor teamId={id} />
        </div>
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
        title="Remove member?"
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
