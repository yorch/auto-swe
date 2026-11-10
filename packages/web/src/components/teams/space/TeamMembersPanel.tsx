'use client';

import type { TeamSummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { AddMemberModal } from '@/components/teams/AddMemberModal';
import { ActionMenu } from '@/components/ui/ActionMenu';
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
import { usePagedRows } from '@/hooks/usePagedRows';
import { useRemoveTeamMember, useTeam, useUpdateTeamMember } from '@/hooks/useTeams';
import { platformRoleLabel } from '@/lib/govLabels';
import { isRole } from '@/lib/roles';
import { teamPermissions } from '@/lib/teamPermissions';
import { useAuthStore } from '@/stores/authStore';

/** Teams with this many members or fewer are listed without a search box. */
const MEMBER_SEARCH_THRESHOLD = 10;
const ROLE_RANK: Record<string, number> = { ADMIN: 3, ENGINEER: 1, LEAD: 2 };

/**
 * The team's members and their roles. Everyone in the team reads the list; the controls offered
 * are exactly what the gateway will accept from this caller (see `teamPermissions`), judged by
 * the caller's own team role.
 */
export function TeamMembersPanel({ team: summary }: { team: TeamSummary }) {
  const id = summary.id;
  const { data: team, error, isError, isFetching, isLoading, refetch } = useTeam(id);
  const updateMember = useUpdateTeamMember(id);
  const removeMember = useRemoveTeamMember(id);
  const platformRole = useAuthStore((s) => s.user?.role);
  const { canManageMembers: canManage, grantableRoles } = teamPermissions(
    platformRole,
    summary.myRole
  );
  const [adding, setAdding] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmRemoveEmail, setConfirmRemoveEmail] = useState<string | null>(null);
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
  const existingUserIds = memberships.map((m) => m.user?.id ?? '').filter(Boolean);

  return (
    <>
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
              actions={
                canManage
                  ? (m) =>
                      m.user?.id ? (
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
                      ) : null
                  : undefined
              }
              className="max-sm:px-4"
              columns={[
                {
                  cell: (m) => <span className="truncate">{m.user?.email}</span>,
                  header: 'Member',
                  id: 'member',
                  primary: true,
                  secondary: (m) => <>Platform role: {platformRoleLabel(m.user?.role ?? '')}</>,
                },
                {
                  cell: (m) =>
                    canManage && m.user?.id && isRole(m.role) && grantableRoles.includes(m.role) ? (
                      <RoleSelectCell
                        apply={(role) =>
                          updateMember.mutateAsync({
                            role: role as 'ADMIN' | 'LEAD' | 'ENGINEER',
                            userId: m.user?.id ?? '',
                          })
                        }
                        ariaLabel={`Team role for ${m.user.email ?? 'member'}`}
                        confirm={(from, to) =>
                          (ROLE_RANK[to] ?? 0) > (ROLE_RANK[from] ?? 0) && to !== 'ENGINEER'
                            ? {
                                confirmLabel: `Make ${platformRoleLabel(to)}`,
                                message: `${m.user?.email ?? 'This member'} will become a team ${platformRoleLabel(to)} on ${team.name}${to === 'LEAD' ? ', able to manage its members, persona and callback endpoints' : ', able to manage everything a lead can, plus the team agent library'}.`,
                                title: `Make ${platformRoleLabel(to)}?`,
                              }
                            : null
                        }
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
    </>
  );
}
