'use client';

import type { TeamSummary } from '@auto-swe/shared/types/api';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AddMemberModal } from '@/components/teams/AddMemberModal';
import { InviteTeamMemberModal } from '@/components/teams/InviteTeamMemberModal';
import { TeamJoinRequestsPanel } from '@/components/teams/space/TeamJoinRequestsPanel';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { RoleSelectCell } from '@/components/users/RoleSelectCell';
import { useCan, useGrantableTeamRoles, usePlatformAdmin } from '@/hooks/useCan';
import { useEffectivePermissions } from '@/hooks/useEffectivePermissions';
import { usePagedRows } from '@/hooks/usePagedRows';
import { useLeaveTeam, useRemoveTeamMember, useTeam, useUpdateTeamMember } from '@/hooks/useTeams';
import {
  platformRoleLabel,
  type TeamRoleValue,
  teamRoleConsequence,
  teamRoleLabel,
  teamRoleRank,
} from '@/lib/roleLabels';
import { useAuthStore } from '@/stores/authStore';

/** Teams with this many members or fewer are listed without a search box. */
const MEMBER_SEARCH_THRESHOLD = 10;

/**
 * The team's members and their roles. Everyone in the team reads the list; the controls offered
 * are what the server's effective permissions say this caller may do here (`team.members.manage`
 * and the roles it lets them grant).
 */
export function TeamMembersPanel({ team: summary }: { team: TeamSummary }) {
  const id = summary.id;
  const { data: team, error, isError, isFetching, isLoading, refetch } = useTeam(id);
  const updateMember = useUpdateTeamMember(id);
  const removeMember = useRemoveTeamMember(id);
  const leaveTeam = useLeaveTeam(id);
  const router = useRouter();
  const canManage = useCan('team.members.manage', { orgId: summary.orgId, teamId: id });
  const grantableRoles = useGrantableTeamRoles(id);
  const sub = useAuthStore((s) => s.user?.sub ?? null);
  // An organization or platform admin on the team reaches it through that authority, so leaving
  // drops their team role and nothing else. The organization's own governance entry says which.
  const platformAdmin = usePlatformAdmin();
  const { data: perms } = useEffectivePermissions();
  const keepsGovernance =
    platformAdmin ||
    (perms?.organizations ?? []).some(
      (o) => o.orgId === summary.orgId && o.capabilities.some((c) => c.key === 'org.members.manage')
    );
  // The server refuses a change to a member who outranks the caller's effective rank, and the
  // roles the caller may grant run up to that rank, so the highest of them bounds who is editable.
  const topGrantableRank = Math.max(-1, ...grantableRoles.map(teamRoleRank));
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmRemoveEmail, setConfirmRemoveEmail] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const memberships = team?.memberships ?? [];
  const memberQuery = memberSearch.trim().toLowerCase();
  const filteredMemberships = memberships.filter(
    (m) => !memberQuery || (m.user?.email ?? '').toLowerCase().includes(memberQuery)
  );
  const memberPager = usePagedRows(filteredMemberships, 25, memberQuery);

  if (isLoading || isError || !team) {
    return (
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="members"
        onRetry={() => void refetch()}
        shape="detail"
      />
    );
  }
  // The roles offered on a row, or none when the row is read-only. Someone else's row offers every
  // grantable role when the caller outranks them or ties. The caller's own row offers only a raise
  // (the path an organization or platform admin on the team takes team powers): the server refuses
  // any lowering as SELF_DEMOTION.
  const editableRoles = (m: { role: string; user?: { id?: string } | null }): TeamRoleValue[] => {
    if (!grantableRoles.includes(m.role as TeamRoleValue)) {
      return [];
    }
    if (m.user?.id !== sub) {
      return [...grantableRoles];
    }
    const above = grantableRoles.filter((r) => teamRoleRank(r) > teamRoleRank(m.role));
    return above.length > 0 ? [m.role as TeamRoleValue, ...above] : [];
  };
  const existingUserIds = memberships.map((m) => m.user?.id ?? '').filter(Boolean);

  return (
    <>
      {notice && <Alert variant="success">{notice}</Alert>}
      <Card className="p-4 sm:p-6">
        <CardHeader>
          <CardTitle>Members</CardTitle>
          {canManage && (
            <Button onClick={() => setInviting(true)} size="sm">
              Invite by email
            </Button>
          )}
          {canManage && memberships.length > 0 && (
            <Button onClick={() => setAdding(true)} size="sm" variant="primary">
              <Icon name="plus" size={14} />
              Add member
            </Button>
          )}
        </CardHeader>
        {!canManage && (
          <p className="mb-3 text-sm text-paper-500">Team leads and admins manage members.</p>
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
          <div className="-mx-4">
            {memberships.length > MEMBER_SEARCH_THRESHOLD && (
              <Toolbar className="px-4">
                <SearchInput
                  label="Search members"
                  onChange={setMemberSearch}
                  placeholder="Search members…"
                  value={memberSearch}
                />
              </Toolbar>
            )}
            <DataTable
              actions={(m) => {
                // Anyone may leave; the server refuses the last admin and the dialog says so.
                if (m.user?.id && m.user.id === sub) {
                  return (
                    <ActionMenu
                      items={[
                        {
                          disabled: leaveTeam.isPending,
                          icon: 'trash',
                          id: 'leave',
                          label: 'Leave team',
                          onAction: () => setConfirmLeave(true),
                          tone: 'danger',
                        },
                      ]}
                      label={`More actions for ${m.user.email ?? 'member'}`}
                    />
                  );
                }
                // A member above the caller's own rank is not theirs to remove: the server
                // refuses it.
                return canManage && m.user?.id && teamRoleRank(m.role) <= topGrantableRank ? (
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
                ) : null;
              }}
              className="max-sm:px-4"
              columns={[
                {
                  cell: (m) => <span className="truncate">{m.user?.email}</span>,
                  header: 'Member',
                  id: 'member',
                  primary: true,
                  // The server sends the platform role only to people who manage users.
                  secondary: (m) =>
                    m.user?.role ? <>Platform role: {platformRoleLabel(m.user.role)}</> : null,
                },
                {
                  cell: (m) =>
                    canManage && m.user?.id && editableRoles(m).length > 0 ? (
                      <RoleSelectCell
                        apply={(role) =>
                          updateMember.mutateAsync({
                            role: role as TeamRoleValue,
                            userId: m.user?.id ?? '',
                          })
                        }
                        ariaLabel={`Team role for ${m.user.email ?? 'member'}`}
                        confirm={(from, to) =>
                          teamRoleRank(to) > teamRoleRank(from) && teamRoleRank(to) > 0
                            ? {
                                confirmLabel: `Make ${teamRoleLabel(to).toLowerCase()}`,
                                message: `${m.user?.email ?? 'This member'} will become a ${teamRoleLabel(to).toLowerCase()} on ${team.name}, ${teamRoleConsequence(to)}.`,
                                title: `Make ${teamRoleLabel(to).toLowerCase()}?`,
                              }
                            : null
                        }
                        options={editableRoles(m).map((r) => ({
                          label: teamRoleLabel(r),
                          value: r,
                        }))}
                        value={m.role}
                      />
                    ) : (
                      <Badge tone="neutral" variant="outline">
                        {teamRoleLabel(m.role)}
                      </Badge>
                    ),
                  header: 'Team role',
                  id: 'role',
                },
              ]}
              getRowId={(m) => m.id}
              revealActions={false}
              rows={memberPager.pageRows}
            />
            {memberPager.paged && (
              <div className="mt-4 border-t border-ink-600 px-4 pt-4">
                <Pagination
                  hasNext={memberPager.hasNext}
                  hasPrev={memberPager.hasPrev}
                  onNext={memberPager.onNext}
                  onPrev={memberPager.onPrev}
                  rangeEnd={memberPager.rangeEnd}
                  rangeStart={memberPager.rangeStart}
                  total={memberPager.total}
                />
              </div>
            )}
          </div>
        )}
      </Card>
      {canManage && (
        <TeamJoinRequestsPanel grantableRoles={grantableRoles} teamId={id} teamName={team.name} />
      )}
      <AddMemberModal
        existingUserIds={existingUserIds}
        grantableRoles={grantableRoles}
        onClose={() => setAdding(false)}
        open={adding}
        orgId={summary.orgId}
        teamId={id}
      />
      <InviteTeamMemberModal
        grantableRoles={grantableRoles}
        onClose={() => setInviting(false)}
        onInvited={setNotice}
        open={inviting}
        teamId={id}
      />
      <ConfirmModal
        confirmLabel="Leave team"
        dangerous
        message={
          keepsGovernance
            ? `You will leave ${team.name} as a member and lose your team role. You keep access to it through your organization or platform administration.`
            : `You will lose access to ${team.name} and its repositories. A team admin can add you back.`
        }
        onClose={() => setConfirmLeave(false)}
        onConfirm={async () => {
          await leaveTeam.mutateAsync();
          router.push('/teams');
        }}
        open={confirmLeave}
        title={`Leave ${team.name}?`}
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
    </>
  );
}
