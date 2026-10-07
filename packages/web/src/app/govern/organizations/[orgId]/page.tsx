'use client';

import { use, useEffect, useState } from 'react';
import { MemberUserPicker } from '@/components/MemberUserPicker';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { BackLink } from '@/components/ui/BackLink';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useHasRole } from '@/hooks/useHasRole';
import {
  type OrgRole,
  useInviteOrgMember,
  useOrg,
  useOrgBudget,
  useOrgMembers,
  usePatchOrg,
  usePatchOrgBudget,
  usePatchOrgMember,
  useRemoveOrgMember,
  useUpsertOrgMember,
} from '@/hooks/useOrg';
import { usePrefilledField } from '@/hooks/usePrefilledField';
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

export default function OrgAdminPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId: rawOrgId } = use(params);
  const orgId = validateRouteParam(rawOrgId);

  const membersQuery = useOrgMembers(orgId ?? '');
  const budgetQuery = useOrgBudget(orgId ?? '');
  const orgQuery = useOrg(orgId ?? '');
  const members = membersQuery.data;
  const budget = budgetQuery.data;
  const org = orgQuery.data;
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

  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [orgError, setOrgError] = useState<string | null>(null);

  useEffect(() => {
    if (org) {
      setOrgName(org.name);
      setOrgSlug(org.slug);
    }
  }, [org]);
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<OrgRole>('ORG_MEMBER');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrgRole>('ORG_MEMBER');
  const [inviteError, setInviteError] = useState<string | null>(null);
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

  if (!orgId) {
    return (
      <div className="space-y-6">
        <BackLink href="/govern/organizations" label="Organizations" />
        <EmptyState
          action={<ButtonLink href="/govern/organizations">Back to organizations</ButtonLink>}
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
    if (!addUserId) {
      setError('Pick a user to add');
      return;
    }
    try {
      await upsertMember.mutateAsync({ role: addRole, userId: addUserId });
      setAddUserId('');
    } catch (e) {
      setError(errMsg(e, 'Failed to add member'));
    }
  }

  async function handleRoleChange(userId: string, role: OrgRole) {
    setError(null);
    try {
      await patchMember.mutateAsync({ role, userId });
    } catch (e) {
      setError(errMsg(e, 'Failed to update role'));
    }
  }

  async function handleInvite() {
    setInviteError(null);
    const email = inviteEmail.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInviteError('Enter a valid email address');
      return;
    }
    try {
      await inviteMember.mutateAsync({ email, orgRole: inviteRole });
      setInviteEmail('');
      setInviteRole('ORG_MEMBER');
    } catch (e) {
      setInviteError(errMsg(e, 'Failed to invite member'));
    }
  }

  async function handleSaveOrg() {
    setOrgError(null);
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
    } catch (e) {
      setOrgError(errMsg(e, 'Failed to update organization'));
    }
  }

  const currentBudget = {
    budgetAlertThresholdPercent: budget?.budgetAlertThresholdPercent ?? null,
    monthlyBudgetUsdCents: budget?.monthlyBudgetUsdCents ?? null,
  };

  async function handleSaveBudget() {
    setBudgetError(null);
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
      <BackLink href="/govern/organizations" label="Organizations" />
      <PageHeader
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
            isLoading={false}
            label="members"
            onRetry={() => void membersQuery.refetch()}
          >
            {membersQuery.isLoading ? (
              <SkeletonRows rows={3} />
            ) : memberCount === 0 ? (
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
              <Table stacked>
                <THead>
                  <Th className="pl-0" variant="plain">
                    Member
                  </Th>
                  <Th variant="plain">Organization role</Th>
                  {canAdmin && (
                    <Th className="pr-0" variant="plain">
                      <span className="sr-only">Actions</span>
                    </Th>
                  )}
                </THead>
                <tbody>
                  {(members ?? []).map((m) => {
                    const isMe = m.userId === authUserId;
                    return (
                      <TRow hover key={m.id}>
                        <Td className="py-3 pr-4" primary>
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium text-paper-100">
                              {m.user.email}
                            </span>
                            {isMe && (
                              <Badge tone="ember" variant="outline">
                                You
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5 truncate text-xs font-normal text-paper-500">
                            {m.user.name ? `${m.user.name} · ` : ''}Platform role:{' '}
                            {platformRoleLabel(m.user.role)}
                          </div>
                        </Td>
                        <Td className="px-4 py-3" label="Organization role">
                          {canAdmin && !isMe ? (
                            <Select
                              aria-label={`Org role for ${m.user.email}`}
                              className="w-48"
                              compact
                              onChange={(role) => {
                                if (isOrgRole(role)) {
                                  handleRoleChange(m.userId, role);
                                }
                              }}
                              options={ORG_ROLE_OPTIONS}
                              value={m.role}
                            />
                          ) : (
                            <Badge
                              title={isMe ? 'You cannot change your own role' : undefined}
                              tone={m.role === 'ORG_ADMIN' ? 'ember' : 'neutral'}
                              variant="outline"
                            >
                              {orgRoleLabel(m.role)}
                            </Badge>
                          )}
                        </Td>
                        {canAdmin && (
                          <Td align="right" className="py-3 pl-4">
                            {isMe ? (
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
                            )}
                          </Td>
                        )}
                      </TRow>
                    );
                  })}
                </tbody>
              </Table>
            )}
            {canAdmin && (
              <div className="mt-6 grid grid-cols-1 gap-6 border-t border-ink-600 pt-5 xl:grid-cols-2">
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-paper-100">Add an existing user</h4>
                  <MemberUserPicker
                    existingUserIds={memberIds}
                    label="User"
                    onChange={setAddUserId}
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
                  <Input
                    label="Email"
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="colleague@example.com"
                    type="email"
                    value={inviteEmail}
                  />
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
                      onClick={handleInvite}
                      variant="secondary"
                    >
                      {inviteMember.isPending ? 'Inviting…' : 'Send invite'}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </QueryBoundary>
        </Card>

        <div className="space-y-6">
          {/* ── Budget ── */}
          <Card>
            <CardHeader className="mb-3">
              <CardTitle eyebrow="Billing">Monthly budget</CardTitle>
              {budget &&
                (cap == null ? (
                  <Badge tone="muted" variant="outline">
                    No cap
                  </Badge>
                ) : overThreshold ? (
                  <Badge dot tone="brick">
                    Over threshold
                  </Badge>
                ) : (
                  <Badge dot tone="moss" variant="text">
                    Within budget
                  </Badge>
                ))}
            </CardHeader>
            <QueryBoundary
              error={budgetQuery.error}
              isError={budgetQuery.isError}
              isFetching={budgetQuery.isFetching}
              isLoading={false}
              label="budget"
              onRetry={() => void budgetQuery.refetch()}
            >
              {budgetQuery.isLoading ? (
                <SkeletonRows rows={3} />
              ) : (
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
                              ? 'bg-brick-400'
                              : overThreshold
                                ? 'bg-amber-400'
                                : 'bg-moss-400'
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
                    <div className="space-y-4 border-t border-ink-600 pt-4">
                      <Input
                        hint="In dollars, e.g. 100.00. Leave blank for no cap."
                        label="Monthly cap"
                        min="0"
                        onChange={(e) => setBudgetInput(e.target.value)}
                        placeholder="No cap"
                        prefix="$"
                        step="0.01"
                        type="number"
                        value={budgetInput}
                      />
                      <Input
                        hint="Warn when spend crosses this percent of the cap (0–100). Blank disables it."
                        label="Alert threshold (%)"
                        onChange={(e) => setThresholdInput(e.target.value)}
                        placeholder="Not set"
                        type="number"
                        value={thresholdInput}
                      />
                      <div className="flex flex-wrap justify-end gap-2">
                        {budget?.monthlyBudgetUsdCents != null && (
                          <Button
                            disabled={patchBudget.isPending}
                            onClick={() => setConfirmRemoveCap(true)}
                            variant="ghost"
                          >
                            Remove cap
                          </Button>
                        )}
                        <Button
                          disabled={patchBudget.isPending}
                          onClick={handleSaveBudget}
                          variant="secondary"
                        >
                          {patchBudget.isPending ? 'Saving…' : 'Save budget'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </QueryBoundary>
          </Card>

          {/* ── Profile ── */}
          <Card>
            <CardHeader className="mb-3">
              <CardTitle eyebrow="Organization">Profile</CardTitle>
            </CardHeader>
            <QueryBoundary
              error={orgQuery.error}
              isError={orgQuery.isError}
              isFetching={orgQuery.isFetching}
              isLoading={false}
              label="organization"
              onRetry={() => void orgQuery.refetch()}
            >
              {orgQuery.isLoading ? (
                <SkeletonRows rows={2} />
              ) : (
                <div className="space-y-4">
                  {orgError ? <Alert variant="error">{orgError}</Alert> : null}
                  <Input
                    label="Name"
                    onChange={(e) => setOrgName(e.target.value)}
                    readOnly={!canAdmin}
                    value={orgName}
                  />
                  <Input
                    className="font-mono"
                    hint="Lowercase letters, numbers and hyphens"
                    label="Slug"
                    onChange={(e) => setOrgSlug(e.target.value)}
                    readOnly={!canAdmin}
                    value={orgSlug}
                  />
                  {canAdmin && (
                    <div className="flex justify-end">
                      <Button
                        disabled={patchOrg.isPending}
                        onClick={handleSaveOrg}
                        variant="secondary"
                      >
                        {patchOrg.isPending ? 'Saving…' : 'Save profile'}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </QueryBoundary>
          </Card>
        </div>
      </div>

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
