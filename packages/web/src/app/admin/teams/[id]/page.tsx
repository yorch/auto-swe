'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { KnowledgeBaseLinksPanel } from '@/components/knowledgeBases/KnowledgeBaseLinksSection';
import { AddMemberModal } from '@/components/teams/AddMemberModal';
import { EgressAllowlistEditor } from '@/components/teams/EgressAllowlistEditor';
import { EventEndpointsCard } from '@/components/teams/EventEndpointsCard';
import { ServicePrincipalsSection } from '@/components/teams/ServicePrincipalsSection';
import { ShellAllowlistEditor } from '@/components/teams/ShellAllowlistEditor';
import { TeamAgentLibrarySection } from '@/components/teams/TeamAgentLibrarySection';
import { TeamCallbackEndpointsSection } from '@/components/teams/TeamCallbackEndpointsSection';
import { TeamFormModal } from '@/components/teams/TeamFormModal';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { BackLink } from '@/components/ui/BackLink';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { RoleSelectCell } from '@/components/users/RoleSelectCell';
import { usePagedRows } from '@/hooks/usePagedRows';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { useRemoveTeamMember, useTeam, useUpdateTeam, useUpdateTeamMember } from '@/hooks/useTeams';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { ApiError, api } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { platformRoleLabel } from '@/lib/govLabels';
import { hasRole, isRole } from '@/lib/roles';
import { validateRouteParam } from '@/lib/routeParams';
import { teamPermissions } from '@/lib/teamPermissions';
import { plural } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

type TeamTab = 'overview' | 'service-principals' | 'automation' | 'sandbox';

/** Teams with this many members or fewer are listed without a search box. */
const MEMBER_SEARCH_THRESHOLD = 10;
/** Persona text beyond this many characters is probably unintended; shown as a counter, not enforced. */
const PERSONA_SOFT_LIMIT = 4000;

const SUBTITLE =
  'Members, repositories, service principals, sandbox allowlists and agent overrides for one team.';

/** Header-only frame for the branches that have no team to show. */
function TeamFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <BackLink href="/admin/teams" label="Teams" />
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
        <span className="truncate font-mono text-sm text-paper-200" title={name}>
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
        action={<ButtonLink href="/admin/teams">Back to teams</ButtonLink>}
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
    canManageCallbacks,
  } = teamPermissions(platformRole, ownTeamRole);
  const updateTeam = useUpdateTeam(id ?? '');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { params: urlParams, update: updateUrl } = useUrlFilters();

  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmRemoveEmail, setConfirmRemoveEmail] = useState<string | null>(null);
  const [personaInput, setPersonaInput] = usePrefilledField(team?.defaultPersonaPrompt);
  const [personaError, setPersonaError] = useState<string | null>(null);
  const [confirmClearPersona, setConfirmClearPersona] = useState(false);
  const [personaSaved, setPersonaSaved] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const memberships = team?.memberships ?? [];
  const memberQuery = memberSearch.trim().toLowerCase();
  const filteredMemberships = memberships.filter(
    (m) => !memberQuery || (m.user?.email ?? '').toLowerCase().includes(memberQuery)
  );
  const memberPager = usePagedRows(filteredMemberships, 25, memberQuery);

  if (!id) {
    return <TeamNotFound />;
  }

  async function handleSavePersona() {
    setPersonaError(null);
    setPersonaSaved(false);
    const next = personaInput.trim();
    // Save never clears: emptying the text is not a deliberate delete, so it
    // is refused and the confirmed "Clear persona" action is the only way.
    if (!next) {
      setPersonaError('Enter a persona to save, or use "Clear persona" to remove the current one.');
      return;
    }
    try {
      await updateTeam.mutateAsync({ defaultPersonaPrompt: next });
      setPersonaSaved(true);
    } catch (e) {
      setPersonaError(errMsg(e, 'Failed to update persona'));
    }
  }

  if (isError && error instanceof ApiError && error.status === 403) {
    return (
      <TeamFrame>
        <EmptyState
          action={<ButtonLink href="/admin/teams">Back to teams</ButtonLink>}
          bordered
          hint="Only members of a team and admins can open it."
          icon="teams"
          title="You do not have access to this team"
        />
      </TeamFrame>
    );
  }
  if (isError && error instanceof ApiError && error.status === 404) {
    return <TeamNotFound />;
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
          shape="detail"
        />
      </TeamFrame>
    );
  }
  if (!team) {
    return <TeamNotFound />;
  }

  const personaUnchanged = personaInput.trim() === (team.defaultPersonaPrompt ?? '').trim();
  const existingUserIds = memberships.map((m) => m.user?.id ?? '').filter(Boolean);

  const repositories = team.repositories ?? [];
  const shared = team.sharedRepositories ?? [];
  const isPlatformAdmin = hasRole(platformRole, 'ADMIN');

  const tabs: { id: TeamTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    ...(canManage ? [{ id: 'service-principals' as const, label: 'Service principals' }] : []),
    { id: 'automation', label: 'Events & agents' },
    ...(canEditAllowlists ? [{ id: 'sandbox' as const, label: 'Sandbox policy' }] : []),
  ];
  // The tab lives in the URL so a section can be linked to and survives a reload.
  const rawTab = urlParams.get('tab');
  const tab: TeamTab = tabs.some((t) => t.id === rawTab) ? (rawTab as TeamTab) : 'overview';
  const setTab = (next: TeamTab) => updateUrl({ tab: next === 'overview' ? null : next });

  const ROLE_RANK: Record<string, number> = { ADMIN: 3, ENGINEER: 1, LEAD: 2 };

  return (
    <div className="space-y-6">
      <BackLink href="/admin/teams" label="Teams" />
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

      <TabBar
        active={tab}
        ariaLabel="Team sections"
        idPrefix="team"
        onChange={setTab}
        tabs={tabs}
      />

      {tab === 'overview' && (
        <div className="space-y-6" {...tabPanelProps('team', 'overview')}>
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
                        secondary: (m) => (
                          <>Platform role: {platformRoleLabel(m.user?.role ?? '')}</>
                        ),
                      },
                      {
                        cell: (m) =>
                          canManage &&
                          m.user?.id &&
                          isRole(m.role) &&
                          grantableRoles.includes(m.role) ? (
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
                      canManage ? (
                        <>
                          Add one from{' '}
                          <Link
                            className="text-paper-100 underline decoration-paper-600 underline-offset-2 hover:decoration-current"
                            href="/connections"
                          >
                            Connections
                          </Link>
                          .
                        </>
                      ) : (
                        'A team lead or admin can add repositories.'
                      )
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
                          <Badge dot tone={r.isActive ? 'success' : 'muted'} variant="text">
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
                        trailing={
                          <span className="text-xs text-paper-500">from {r.team.name}</span>
                        }
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
                <CardTitle>Default persona</CardTitle>
                {!team.defaultPersonaPrompt && (
                  <Badge tone="muted" variant="outline">
                    Not set
                  </Badge>
                )}
              </CardHeader>
              <p className="mb-4 text-sm text-paper-400">
                Team-wide default persona for every channel assistant. A channel can override it.
              </p>
              <div className="space-y-4">
                {personaError ? <Alert variant="error">{personaError}</Alert> : null}
                <Textarea
                  className="font-sans text-sm"
                  label="Persona"
                  mono={false}
                  onChange={(e) => {
                    setPersonaInput(e.target.value);
                    setPersonaSaved(false);
                  }}
                  placeholder="You are a helpful assistant for this team…"
                  value={personaInput}
                />
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span
                    aria-live="polite"
                    className={`mr-auto text-xs ${personaInput.length > PERSONA_SOFT_LIMIT ? 'text-warning-400' : 'text-paper-500'}`}
                  >
                    {personaSaved && personaUnchanged
                      ? 'Persona saved. '
                      : personaUnchanged
                        ? ''
                        : 'Unsaved changes. '}
                    {personaInput.length.toLocaleString()} characters
                    {personaInput.length > PERSONA_SOFT_LIMIT
                      ? ' — long personas cost tokens on every message'
                      : ''}
                  </span>
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

          {isPlatformAdmin && (
            <Card className="border-danger-400/30">
              <CardHeader className="mb-1">
                <CardTitle>Delete team</CardTitle>
              </CardHeader>
              <p className="mb-4 text-sm text-paper-400">
                Deactivates this team so it no longer appears in the directory. Its audit history is
                kept.
              </p>
              <Button onClick={() => setConfirmDelete(true)} variant="danger-solid">
                Delete team
              </Button>
            </Card>
          )}
        </div>
      )}

      {tab === 'service-principals' && canManage && (
        <div {...tabPanelProps('team', 'service-principals')}>
          <ServicePrincipalsSection
            repositories={[...repositories.filter((r) => r.isActive), ...shared].map((r) => ({
              id: r.id,
              label: `${r.organizationName}/${r.repoName}`,
            }))}
            teamId={id}
          />
        </div>
      )}

      {tab === 'automation' && (
        <div className="space-y-6" {...tabPanelProps('team', 'automation')}>
          <EventEndpointsCard team={{ id, name: team.name }} />
          <KnowledgeBaseLinksPanel
            canManage={canManage}
            target={{ scope: 'TEAM', teamId: id }}
            teamId={id}
          />
          {canManageTeamAgents && <TeamAgentLibrarySection teamId={id} />}
          {canManageCallbacks && (
            <TeamCallbackEndpointsSection isPlatformAdmin={isPlatformAdmin} teamId={id} />
          )}
        </div>
      )}

      {tab === 'sandbox' && canEditAllowlists && (
        <div
          className="grid grid-cols-1 gap-6 lg:grid-cols-2"
          {...tabPanelProps('team', 'sandbox')}
        >
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
        confirmLabel="Delete team"
        confirmText={team.name}
        dangerous
        message={`${team.name} is deactivated: it disappears from the team directory and its members lose access through it. Type the team name to confirm.`}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await api.delete(`/api/v1/teams/${id}`);
          await queryClient.invalidateQueries({ queryKey: ['teams'] });
          router.push('/admin/teams');
        }}
        open={confirmDelete}
        title="Delete team?"
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
