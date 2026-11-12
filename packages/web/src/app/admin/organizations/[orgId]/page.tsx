'use client';

import { use, useEffect, useState } from 'react';
import { MemberUserPicker } from '@/components/MemberUserPicker';
import { OrganizationGithub } from '@/components/organizations/OrganizationGithub';
import { BudgetMeter } from '@/components/teams/BudgetMeter';
import { TeamFormModal } from '@/components/teams/TeamFormModal';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { RoleSelectCell } from '@/components/users/RoleSelectCell';
import { useDataTableSort } from '@/hooks/useDataTableSort';
import { useEntityTitle } from '@/hooks/useEntityTitle';
import { useHasRole } from '@/hooks/useHasRole';
import {
  type OrgRole,
  useInviteOrgMember,
  useOrg,
  useOrgBudget,
  useOrgBudgetStatus,
  useOrgMembers,
  usePatchOrg,
  usePatchOrgBudget,
  usePatchOrgMember,
  useRemoveOrgMember,
  useUpsertOrgMember,
} from '@/hooks/useOrg';
import { usePagedRows } from '@/hooks/usePagedRows';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { useTeams } from '@/hooks/useTeams';
import { buildBudgetPatch, centsToDollarsInput, removeCapPatch } from '@/lib/budgetPatch';
import { errMsg } from '@/lib/errors';
import { ORG_ROLE_OPTIONS, orgRoleLabel, platformRoleLabel } from '@/lib/govLabels';
import { validateRouteParam } from '@/lib/routeParams';
import { cn, formatCents, formatPercent, formatTokens, plural } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

const ORG_ROLES: readonly OrgRole[] = ['ORG_MEMBER', 'ORG_ADMIN'];

function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

/** Members below this count are listed without a search box. */
const MEMBER_SEARCH_THRESHOLD = 10;

type OrgMemberRow = NonNullable<ReturnType<typeof useOrgMembers>['data']>[number];

const MEMBER_SORT = {
  member: (m: OrgMemberRow) => m.user.email.toLowerCase(),
  role: (m: OrgMemberRow) => m.role,
};

export default function OrgAdminPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId: rawOrgId } = use(params);
  const orgId = validateRouteParam(rawOrgId);

  const membersQuery = useOrgMembers(orgId ?? '');
  const orgQuery = useOrg(orgId ?? '');
  const members = membersQuery.data;
  const org = orgQuery.data;
  useEntityTitle(org?.name);
  const upsertMember = useUpsertOrgMember(orgId ?? '');
  const patchMember = usePatchOrgMember(orgId ?? '');
  const removeMember = useRemoveOrgMember(orgId ?? '');
  const inviteMember = useInviteOrgMember(orgId ?? '');
  const patchOrg = usePatchOrg(orgId ?? '');
  const patchBudget = usePatchOrgBudget(orgId ?? '');

  const authUserId = useAuthStore((s) => s.user?.sub ?? null);
  // Every write on this page is `requiredOrgRole: 'ORG_ADMIN'` (platform ADMIN
  // bypasses); an ORG_MEMBER reads the same data but gets no controls.
  const isPlatformAdmin = useHasRole('ADMIN');
  const canAdmin =
    isPlatformAdmin ||
    (members ?? []).some((m) => m.userId === authUserId && m.role === 'ORG_ADMIN');
  // The dollar budget is an ORG_ADMIN's; a plain member reads the percentage-only status instead.
  const budgetQuery = useOrgBudget(orgId ?? '', canAdmin);
  const budget = budgetQuery.data;
  const budgetStatusQuery = useOrgBudgetStatus(orgId ?? '', membersQuery.isSuccess && !canAdmin);

  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [orgError, setOrgError] = useState<string | null>(null);

  useEffect(() => {
    if (org) {
      setOrgName(org.name);
      setOrgSlug(org.slug);
    }
  }, [org]);
  const [confirmTrust, setConfirmTrust] = useState(false);
  const [trustError, setTrustError] = useState<string | null>(null);
  async function applyTrust(next: boolean) {
    setTrustError(null);
    try {
      await patchOrg.mutateAsync({ trustedInvites: next });
    } catch (e) {
      setTrustError(errMsg(e, 'Failed to update invite trust'));
      throw e;
    }
  }

  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<OrgRole>('ORG_MEMBER');
  const [inviteEmail, setInviteEmail] = useState('');
  const teams = useTeams({ enabled: canAdmin });
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [inviteTeamId, setInviteTeamId] = useState('');
  const [inviteTeamRole, setInviteTeamRole] = useState<'ADMIN' | 'LEAD' | 'ENGINEER'>('ENGINEER');
  const [inviteRole, setInviteRole] = useState<OrgRole>('ORG_MEMBER');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const [addNotice, setAddNotice] = useState<string | null>(null);
  const [orgSaved, setOrgSaved] = useState(false);
  const [budgetSaved, setBudgetSaved] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const memberSort = useDataTableSort<OrgMemberRow>(MEMBER_SORT);
  // Prefilled with the stored values so an untouched field is sent back as-is.
  const [budgetInput, setBudgetInput] = usePrefilledField(
    centsToDollarsInput(budget?.monthlyBudgetUsdCents)
  );
  const [thresholdInput, setThresholdInput] = usePrefilledField(
    budget?.budgetAlertThresholdPercent
  );
  const [confirmRemoveCap, setConfirmRemoveCap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{ userId: string; email: string } | null>(
    null
  );

  const memberIds = (members ?? []).map((m) => m.userId);
  const memberQuery = memberSearch.trim().toLowerCase();
  const filteredMembers = (members ?? []).filter(
    (m) =>
      !memberQuery ||
      m.user.email.toLowerCase().includes(memberQuery) ||
      (m.user.name ?? '').toLowerCase().includes(memberQuery)
  );
  const memberPager = usePagedRows(memberSort.sortRows(filteredMembers), 25, memberQuery);
  const adminCount = (members ?? []).filter((m) => m.role === 'ORG_ADMIN').length;

  if (!orgId) {
    return (
      <div className="space-y-6">
        <EmptyState
          action={<ButtonLink href="/admin/organizations">Back to organizations</ButtonLink>}
          bordered
          hint="The link is malformed or the organization no longer exists."
          icon="building"
          title="Organization not found"
        />
      </div>
    );
  }

  async function handleAddMember() {
    setError(null);
    setAddNotice(null);
    if (!addUserId) {
      setError('Pick a user to add');
      return;
    }
    try {
      await upsertMember.mutateAsync({ role: addRole, userId: addUserId });
      setAddNotice('Member added.');
      setAddUserId('');
    } catch (e) {
      setError(errMsg(e, 'Failed to add member'));
    }
  }

  async function handleInvite() {
    setInviteError(null);
    setInviteNotice(null);
    const email = inviteEmail.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInviteError('Enter a valid email address');
      return;
    }
    try {
      const result = await inviteMember.mutateAsync({
        email,
        orgRole: inviteRole,
        ...(inviteTeamId ? { teamId: inviteTeamId, teamRole: inviteTeamRole } : {}),
      });
      setInviteNotice(
        result.data.isActive
          ? `Invite sent to ${email}. Their account is approved when they follow the link.`
          : `Invite sent to ${email}. They wait in the platform approval queue until an admin approves them.`
      );
      setInviteEmail('');
      setInviteRole('ORG_MEMBER');
      setInviteTeamId('');
      setInviteTeamRole('ENGINEER');
    } catch (e) {
      setInviteError(errMsg(e, 'Failed to invite member'));
    }
  }

  const orgDirty = org != null && (orgName.trim() !== org.name || orgSlug.trim() !== org.slug);

  async function handleSaveOrg() {
    setOrgError(null);
    setOrgSaved(false);
    const name = orgName.trim();
    const slug = orgSlug.trim();
    if (!name || !slug) {
      setOrgError('Name and slug are required');
      return;
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      setOrgError('Slug must be lowercase kebab-case');
      return;
    }
    try {
      await patchOrg.mutateAsync({ name, slug });
      setOrgSaved(true);
    } catch (e) {
      setOrgError(errMsg(e, 'Failed to update organization'));
    }
  }

  const currentBudget = {
    budgetAlertThresholdPercent: budget?.budgetAlertThresholdPercent ?? null,
    monthlyBudgetUsdCents: budget?.monthlyBudgetUsdCents ?? null,
  };

  const budgetDirty =
    buildBudgetPatch(budgetInput, thresholdInput, currentBudget).kind !== 'unchanged';

  async function handleSaveBudget() {
    setBudgetError(null);
    setBudgetSaved(false);
    const result = buildBudgetPatch(budgetInput, thresholdInput, currentBudget);
    if (result.kind === 'invalid') {
      setBudgetError(result.error);
      return;
    }
    if (result.kind === 'unchanged') {
      return;
    }
    try {
      await patchBudget.mutateAsync(result.body);
      setBudgetSaved(true);
    } catch (e) {
      setBudgetError(errMsg(e, 'Failed to update budget'));
    }
  }

  async function handleRemoveCap() {
    setBudgetError(null);
    try {
      await patchBudget.mutateAsync(removeCapPatch(currentBudget));
    } catch (e) {
      setBudgetError(errMsg(e, 'Failed to remove the cap'));
    }
  }

  const cap = budget?.monthlyBudgetUsdCents ?? null;
  const threshold = budget?.budgetAlertThresholdPercent ?? null;
  const spent = budget?.currentMonthSpend.totalUsd ?? 0;
  const usedPercent = cap != null && cap > 0 ? (spent * 10000) / cap : null;
  const overThreshold = usedPercent != null && threshold != null && usedPercent >= threshold;
  const memberCount = members?.length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          canAdmin && (
            <Button onClick={() => setCreatingTeam(true)} variant="primary">
              New team
            </Button>
          )
        }
        subtitle={
          org ? (
            <>
              Members, profile and monthly budget for this organization.
              <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-paper-500">
                <span className="font-mono">{org.slug}</span>
                {members && <span>{plural(memberCount, 'member')}</span>}
              </span>
            </>
          ) : (
            'Members, profile and monthly budget.'
          )
        }
        title={org?.name ?? 'Organization'}
      />
      {canAdmin && orgId && <OrganizationGithub orgId={orgId} />}
      <TeamFormModal
        mode={{ kind: 'create', orgId }}
        onClose={() => setCreatingTeam(false)}
        open={creatingTeam}
      />

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* ── Members ── */}
        <Card className="p-4 sm:p-6">
          <CardHeader>
            <CardTitle>Members</CardTitle>
            {members && (
              <span className="text-xs text-paper-500 tabular-nums">
                {plural(memberCount, 'member')}
              </span>
            )}
          </CardHeader>
          <QueryBoundary
            error={membersQuery.error}
            isError={membersQuery.isError}
            isFetching={membersQuery.isFetching}
            isLoading={membersQuery.isLoading}
            label="members"
            onRetry={() => void membersQuery.refetch()}
            rows={3}
          >
            {memberCount === 0 ? (
              <EmptyState
                className="py-6"
                hint={
                  canAdmin
                    ? 'Add an existing user or invite someone by email below.'
                    : 'Nobody belongs to this organization yet.'
                }
                icon="users"
                title="No members yet"
              />
            ) : (
              <div className="-mx-4">
                {memberCount > MEMBER_SEARCH_THRESHOLD && (
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
                    canAdmin
                      ? (m) =>
                          m.userId === authUserId ? (
                            <span className="sr-only">You cannot remove yourself</span>
                          ) : (
                            <ActionMenu
                              items={[
                                {
                                  icon: 'trash',
                                  id: 'remove',
                                  label: 'Remove from organization',
                                  onAction: () =>
                                    setPendingRemoval({ email: m.user.email, userId: m.userId }),
                                  tone: 'danger',
                                },
                              ]}
                              label={`More actions for ${m.user.email}`}
                            />
                          )
                      : undefined
                  }
                  className="max-sm:px-4"
                  columns={[
                    {
                      cell: (m) => (
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{m.user.email}</span>
                          {m.userId === authUserId && (
                            <Badge tone="accent" variant="outline">
                              You
                            </Badge>
                          )}
                        </span>
                      ),
                      header: 'Member',
                      id: 'member',
                      primary: true,
                      secondary: (m) => (
                        <span className="block truncate">
                          {m.user.name ? `${m.user.name} · ` : ''}Platform role:{' '}
                          {platformRoleLabel(m.user.role)}
                        </span>
                      ),
                      sortable: true,
                    },
                    {
                      cell: (m) =>
                        canAdmin && m.userId !== authUserId ? (
                          <RoleSelectCell
                            apply={(role) =>
                              patchMember.mutateAsync({ role: role as OrgRole, userId: m.userId })
                            }
                            ariaLabel={`Org role for ${m.user.email}`}
                            className="w-48"
                            confirm={(_from, to) =>
                              to === 'ORG_ADMIN'
                                ? {
                                    confirmLabel: 'Make organization admin',
                                    dangerous: true,
                                    message: `${m.user.email} will be able to manage this organization's members, budget and profile, and to invite people.`,
                                    title: 'Make organization admin?',
                                  }
                                : {
                                    confirmLabel: 'Remove admin rights',
                                    message: `${m.user.email} will no longer be able to manage this organization's members, budget or profile.`,
                                    title: 'Remove organization admin rights?',
                                  }
                            }
                            disabled={m.role === 'ORG_ADMIN' && adminCount <= 1}
                            disabledReason="The only organization admin"
                            options={ORG_ROLE_OPTIONS}
                            value={m.role}
                          />
                        ) : (
                          <Badge
                            title={
                              m.userId === authUserId
                                ? 'You cannot change your own role'
                                : undefined
                            }
                            tone={m.role === 'ORG_ADMIN' ? 'accent' : 'neutral'}
                            variant="outline"
                          >
                            {orgRoleLabel(m.role)}
                          </Badge>
                        ),
                      header: 'Organization role',
                      id: 'role',
                      sortable: true,
                    },
                  ]}
                  getRowId={(m) => m.id}
                  onSortChange={memberSort.onSortChange}
                  revealActions={false}
                  rows={memberPager.pageRows}
                  sort={memberSort.sort}
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
            {canAdmin && (
              <div className="mt-6 grid grid-cols-1 gap-6 border-t border-ink-600 pt-5 xl:grid-cols-2">
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-paper-100">Add an existing user</h4>
                  {addNotice ? <Alert variant="success">{addNotice}</Alert> : null}
                  <MemberUserPicker
                    existingUserIds={memberIds}
                    label="User"
                    onChange={(id) => {
                      setAddUserId(id);
                      setAddNotice(null);
                    }}
                    value={addUserId}
                  />
                  {addUserId !== '' && (
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="min-w-0 flex-1">
                        <Select
                          label="Role"
                          onChange={(role) => {
                            if (isOrgRole(role)) {
                              setAddRole(role);
                            }
                          }}
                          options={ORG_ROLE_OPTIONS}
                          value={addRole}
                        />
                      </div>
                      <Button
                        className="h-9"
                        disabled={upsertMember.isPending}
                        onClick={handleAddMember}
                        variant="primary"
                      >
                        {upsertMember.isPending ? 'Adding…' : 'Add member'}
                      </Button>
                    </div>
                  )}
                </div>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-paper-100">Invite by email</h4>
                  {inviteError ? <Alert variant="error">{inviteError}</Alert> : null}
                  {inviteNotice ? <Alert variant="success">{inviteNotice}</Alert> : null}
                  <form
                    className="space-y-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleInvite();
                    }}
                  >
                    <Input
                      label="Email"
                      onChange={(e) => {
                        setInviteEmail(e.target.value);
                        setInviteNotice(null);
                      }}
                      placeholder="colleague@example.com"
                      type="email"
                      value={inviteEmail}
                    />
                    <Select
                      disabled={teams.isLoading || teams.isError}
                      error={teams.isError ? 'Unable to load teams.' : undefined}
                      label="Team (optional)"
                      onChange={setInviteTeamId}
                      options={[
                        { label: 'No team', value: '' },
                        ...(teams.data ?? [])
                          .filter((t) => t.orgId === orgId)
                          .map((t) => ({ label: t.name, value: t.id })),
                      ]}
                      value={inviteTeamId}
                    />
                    {inviteTeamId && (
                      <Select
                        label="Team role"
                        onChange={(value) =>
                          setInviteTeamRole(value as 'ADMIN' | 'LEAD' | 'ENGINEER')
                        }
                        options={['ENGINEER', 'LEAD', 'ADMIN'].map((role) => ({
                          label: platformRoleLabel(role),
                          value: role,
                        }))}
                        value={inviteTeamRole}
                      />
                    )}
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="min-w-0 flex-1">
                        <Select
                          label="Role"
                          onChange={(role) => {
                            if (isOrgRole(role)) {
                              setInviteRole(role);
                            }
                          }}
                          options={ORG_ROLE_OPTIONS}
                          value={inviteRole}
                        />
                      </div>
                      <Button
                        className="h-9"
                        disabled={inviteMember.isPending}
                        type="submit"
                        variant="secondary"
                      >
                        {inviteMember.isPending ? 'Inviting…' : 'Send invite'}
                      </Button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </QueryBoundary>
        </Card>

        <div className="space-y-6">
          {/* ── Budget ── */}
          <Card>
            <CardHeader className="mb-3">
              <CardTitle>Monthly budget</CardTitle>
              {budget &&
                (cap == null ? (
                  <Badge tone="muted" variant="outline">
                    No cap
                  </Badge>
                ) : overThreshold ? (
                  <Badge dot tone="danger">
                    Over threshold
                  </Badge>
                ) : (
                  <Badge dot tone="success" variant="text">
                    Within budget
                  </Badge>
                ))}
            </CardHeader>
            {!canAdmin ? (
              <QueryBoundary
                error={budgetStatusQuery.error}
                isError={budgetStatusQuery.isError}
                isFetching={budgetStatusQuery.isFetching}
                isLoading={budgetStatusQuery.isLoading}
                label="budget"
                onRetry={() => void budgetStatusQuery.refetch()}
                rows={2}
              >
                <BudgetMeter budget={budgetStatusQuery.data} />
              </QueryBoundary>
            ) : (
              <QueryBoundary
                error={budgetQuery.error}
                isError={budgetQuery.isError}
                isFetching={budgetQuery.isFetching}
                isLoading={budgetQuery.isLoading}
                label="budget"
                onRetry={() => void budgetQuery.refetch()}
                rows={3}
              >
                <div className="space-y-4">
                  {budgetError ? <Alert variant="error">{budgetError}</Alert> : null}
                  {overThreshold && cap != null && threshold != null && (
                    <Alert variant="warning">
                      Monthly spend is {formatCents(spent * 100)} (
                      {formatPercent((spent * 100) / cap)} of the {formatCents(cap)} cap) — above
                      the {formatPercent(threshold / 100)} alert threshold.
                    </Alert>
                  )}
                  <div>
                    <div className="text-xs text-paper-500">
                      {budget?.currentMonthUsage?.yearMonth
                        ? `Spent in ${budget.currentMonthUsage.yearMonth}`
                        : 'Spent this month'}
                    </div>
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
                      <span className="text-2xl font-semibold tracking-tight text-paper-50 tabular-nums">
                        {formatCents(spent * 100)}
                      </span>
                      <span className="text-sm text-paper-400 tabular-nums">
                        {cap != null ? `of ${formatCents(cap)}` : 'no cap set'}
                      </span>
                    </div>
                    {usedPercent != null && (
                      <div
                        aria-label={`${formatPercent(usedPercent / 100)} of the cap used`}
                        className="relative mt-3 h-2 overflow-hidden rounded-full bg-ink-500"
                        role="img"
                      >
                        <div
                          className={cn(
                            'absolute inset-y-0 left-0 rounded-full',
                            usedPercent >= 100
                              ? 'bg-danger-400'
                              : overThreshold
                                ? 'bg-warning-400'
                                : 'bg-success-400'
                          )}
                          style={{ width: `${Math.min(100, usedPercent)}%` }}
                        />
                        {threshold != null && threshold > 0 && threshold < 100 && (
                          <div
                            className="absolute inset-y-0 w-0.5 bg-paper-200/80"
                            style={{ left: `${threshold}%` }}
                            title={`Alert at ${formatPercent(threshold / 100)}`}
                          />
                        )}
                      </div>
                    )}
                    {usedPercent != null &&
                      threshold != null &&
                      threshold > 0 &&
                      threshold < 100 && (
                        <p className="mt-1 text-xs text-paper-500">
                          Alert at {formatPercent(threshold / 100)} (marked on the bar)
                        </p>
                      )}
                    {budget && (
                      <p className="mt-2 text-xs leading-relaxed text-paper-500">
                        {budget.currentMonthUsage && (
                          <>
                            {plural(budget.currentMonthUsage.runsCompleted, 'run')} ·{' '}
                            {formatTokens(
                              Number(budget.currentMonthUsage.tokensInput) +
                                Number(budget.currentMonthUsage.tokensOutput)
                            )}{' '}
                            tokens ·{' '}
                          </>
                        )}
                        {formatCents(budget.currentMonthSpend.inFlightUsd * 100)} in flight ·{' '}
                        {formatCents(budget.currentMonthSpend.runlessUsd * 100)} without a run
                      </p>
                    )}
                  </div>
                  <dl className="grid grid-cols-2 gap-3 border-t border-ink-600 pt-4 text-sm">
                    <div>
                      <dt className="text-xs text-paper-500">Monthly cap</dt>
                      <dd className="mt-0.5 text-paper-100 tabular-nums">
                        {cap != null ? formatCents(cap) : 'No cap'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-paper-500">Alert threshold</dt>
                      <dd className="mt-0.5 text-paper-100 tabular-nums">
                        {threshold != null ? formatPercent(threshold / 100) : 'Not set'}
                      </dd>
                    </div>
                  </dl>
                  {canAdmin && (
                    <form
                      className="space-y-4 border-t border-ink-600 pt-4"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleSaveBudget();
                      }}
                    >
                      <Input
                        hint="In dollars, e.g. 100.00. Leave blank for no cap."
                        label="Monthly cap"
                        min="0"
                        onChange={(e) => {
                          setBudgetInput(e.target.value);
                          setBudgetSaved(false);
                        }}
                        placeholder="No cap"
                        prefix="$"
                        step="0.01"
                        type="number"
                        value={budgetInput}
                      />
                      <Input
                        hint="Warn when spend crosses this percent of the cap (0–100). Blank disables it."
                        label="Alert threshold (%)"
                        onChange={(e) => {
                          setThresholdInput(e.target.value);
                          setBudgetSaved(false);
                        }}
                        placeholder="Not set"
                        type="number"
                        value={thresholdInput}
                      />
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <span aria-live="polite" className="mr-auto text-xs text-paper-500">
                          {budgetSaved && !budgetDirty
                            ? 'Budget saved.'
                            : budgetDirty
                              ? 'Unsaved changes'
                              : ''}
                        </span>
                        {budget?.monthlyBudgetUsdCents != null && (
                          <Button
                            disabled={patchBudget.isPending}
                            onClick={() => setConfirmRemoveCap(true)}
                            type="button"
                            variant="ghost"
                          >
                            Remove cap
                          </Button>
                        )}
                        <Button
                          disabled={patchBudget.isPending || !budgetDirty}
                          type="submit"
                          variant="secondary"
                        >
                          {patchBudget.isPending ? 'Saving…' : 'Save budget'}
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              </QueryBoundary>
            )}
          </Card>

          {/* ── Profile ── */}
          <Card>
            <CardHeader className="mb-3">
              <CardTitle>Profile</CardTitle>
            </CardHeader>
            <QueryBoundary
              error={orgQuery.error}
              isError={orgQuery.isError}
              isFetching={orgQuery.isFetching}
              isLoading={orgQuery.isLoading}
              label="organization"
              onRetry={() => void orgQuery.refetch()}
              rows={2}
            >
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleSaveOrg();
                }}
              >
                {orgError ? <Alert variant="error">{orgError}</Alert> : null}
                <Input
                  label="Name"
                  onChange={(e) => {
                    setOrgName(e.target.value);
                    setOrgSaved(false);
                  }}
                  readOnly={!canAdmin}
                  value={orgName}
                />
                <Input
                  className="font-mono"
                  hint="Lowercase letters, numbers and hyphens. Changing the slug changes this organization's identifier wherever it is referenced by name."
                  label="Slug"
                  onChange={(e) => {
                    setOrgSlug(e.target.value);
                    setOrgSaved(false);
                  }}
                  readOnly={!canAdmin}
                  value={orgSlug}
                />
                {canAdmin && (
                  <div className="flex items-center justify-end gap-3">
                    <span aria-live="polite" className="mr-auto text-xs text-paper-500">
                      {orgSaved && !orgDirty ? 'Profile saved.' : orgDirty ? 'Unsaved changes' : ''}
                    </span>
                    <Button
                      disabled={patchOrg.isPending || !orgDirty}
                      type="submit"
                      variant="secondary"
                    >
                      {patchOrg.isPending ? 'Saving…' : 'Save profile'}
                    </Button>
                  </div>
                )}
              </form>
            </QueryBoundary>
          </Card>

          {/* ── Invite trust (platform admins only) ── It saves on toggle, so it
              sits outside the profile form, whose unsaved edits a refetch resets. */}
          {isPlatformAdmin && org && (
            <Card>
              <CardHeader className="mb-3">
                <CardTitle>Invite trust</CardTitle>
              </CardHeader>
              <div className="space-y-1">
                <ToggleSwitch
                  checked={org.trustedInvites ?? false}
                  disabled={patchOrg.isPending}
                  label="Trust organization and team invites"
                  onChange={() => {
                    if (org.trustedInvites) {
                      void applyTrust(false).catch(() => undefined);
                    } else {
                      setConfirmTrust(true);
                    }
                  }}
                />
                {trustError ? <Alert variant="error">{trustError}</Alert> : null}
                <p className="text-xs leading-relaxed text-paper-500">
                  When on and the organization is active, invitations from its organization admins
                  and team leads or team admins create approved accounts instead of waiting in the
                  approval queue.
                </p>
              </div>
            </Card>
          )}
        </div>
      </div>

      <ConfirmModal
        confirmLabel="Trust invites"
        dangerous
        message={`Organization admins and team leads or team admins of ${org?.name ?? 'this organization'} can create active accounts by invite while the organization is active, without platform approval. Turn it off again at any time; accounts already created stay active.`}
        onClose={() => setConfirmTrust(false)}
        onConfirm={() => applyTrust(true)}
        open={confirmTrust}
        title="Trust organization and team invites?"
      />

      <ConfirmModal
        confirmLabel="Remove cap"
        dangerous
        message="Remove the monthly budget cap? Spend in this organization will no longer be limited."
        onClose={() => setConfirmRemoveCap(false)}
        onConfirm={handleRemoveCap}
        open={confirmRemoveCap}
        title="Remove budget cap?"
      />

      <ConfirmModal
        confirmLabel="Remove"
        dangerous
        message={`Remove ${pendingRemoval?.email ?? 'this member'} from the organization? They will lose access to all teams nested under it.`}
        onClose={() => setPendingRemoval(null)}
        onConfirm={async () => {
          if (pendingRemoval) {
            await removeMember.mutateAsync(pendingRemoval.userId);
          }
        }}
        open={pendingRemoval !== null}
        title="Remove member?"
      />
    </div>
  );
}
