'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { MemberUserPicker } from '@/components/MemberUserPicker';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Stat } from '@/components/ui/Stat';
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
import { buildBudgetPatch, removeCapPatch } from '@/lib/budgetPatch';
import { errMsg } from '@/lib/errors';
import { validateRouteParam } from '@/lib/routeParams';
import { formatCents, formatPercent, formatTokens } from '@/lib/utils';
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
  const [budgetInput, setBudgetInput] = usePrefilledField(budget?.monthlyBudgetUsdCents);
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
      <EmptyState
        action={<ButtonLink href="/govern/organizations">Back to organizations</ButtonLink>}
        title="Organization not found"
      />
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

  return (
    <div className="space-y-8">
      <Link className="label-mono hover:text-paper-200" href="/govern/organizations">
        ← Organizations
      </Link>
      <PageHeader
        chapter="§ Govern"
        subtitle={
          <>
            Members, profile, and monthly budget for organization{' '}
            <span className="font-mono text-xs">{orgId}</span>.
          </>
        }
        title="Organization settings"
      />

      {error ? <Alert variant="error">{error}</Alert> : null}

      {/* ── Members ── */}
      <Card>
        <CardHeader>
          <CardTitle eyebrow="RBAC">Members</CardTitle>
        </CardHeader>
        <QueryBoundary
          error={membersQuery.error}
          isError={membersQuery.isError}
          isLoading={membersQuery.isLoading}
          label="members"
        >
          <Table>
            <THead>
              <Th className="pr-3" variant="compact">
                Email
              </Th>
              <Th className="pr-3" variant="compact">
                Platform role
              </Th>
              <Th className="pr-3" variant="compact">
                Org role
              </Th>
              <Th variant="compact" />
            </THead>
            <tbody>
              {(members ?? []).map((m) => {
                const isMe = m.userId === authUserId;
                return (
                  <TRow key={m.id}>
                    <Td className="py-3 pr-3 text-paper-100">
                      {m.user.email} {isMe ? <span className="text-paper-500">(you)</span> : null}
                    </Td>
                    <Td className="py-3 pr-3 font-mono text-[11px] text-paper-400">
                      {m.user.role}
                    </Td>
                    <Td className="py-3 pr-3">
                      <Select
                        disabled={isMe || !canAdmin}
                        onChange={(e) => {
                          const role = e.target.value;
                          if (isOrgRole(role)) {
                            handleRoleChange(m.userId, role);
                          }
                        }}
                        value={m.role}
                      >
                        <option value="ORG_ADMIN">ORG_ADMIN</option>
                        <option value="ORG_MEMBER">ORG_MEMBER</option>
                      </Select>
                    </Td>
                    <Td className="py-3 text-right">
                      {canAdmin && (
                        <Button
                          disabled={isMe}
                          onClick={() =>
                            setPendingRemoval({ email: m.user.email, userId: m.userId })
                          }
                          size="sm"
                          variant="danger"
                        >
                          Remove
                        </Button>
                      )}
                    </Td>
                  </TRow>
                );
              })}
            </tbody>
          </Table>
          {canAdmin && (
            <>
              <div className="mt-4 flex items-end gap-3 border-t border-ink-600 pt-4">
                <MemberUserPicker
                  existingUserIds={memberIds}
                  label="Add user"
                  onChange={setAddUserId}
                  value={addUserId}
                />
                {addUserId !== '' && (
                  <>
                    <Select
                      label="Role"
                      onChange={(e) => {
                        const role = e.target.value;
                        if (isOrgRole(role)) {
                          setAddRole(role);
                        }
                      }}
                      value={addRole}
                    >
                      <option value="ORG_MEMBER">ORG_MEMBER</option>
                      <option value="ORG_ADMIN">ORG_ADMIN</option>
                    </Select>
                    <Button
                      disabled={upsertMember.isPending}
                      onClick={handleAddMember}
                      variant="primary"
                    >
                      Add
                    </Button>
                  </>
                )}
              </div>
              <div className="mt-4 space-y-3 border-t border-ink-600 pt-4">
                {inviteError ? <Alert variant="error">{inviteError}</Alert> : null}
                <div className="flex items-end gap-3">
                  <Input
                    label="Invite by email"
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="colleague@example.com"
                    type="email"
                    value={inviteEmail}
                  />
                  <Select
                    label="Role"
                    onChange={(e) => {
                      const role = e.target.value;
                      if (isOrgRole(role)) {
                        setInviteRole(role);
                      }
                    }}
                    value={inviteRole}
                  >
                    <option value="ORG_MEMBER">ORG_MEMBER</option>
                    <option value="ORG_ADMIN">ORG_ADMIN</option>
                  </Select>
                  <Button
                    disabled={inviteMember.isPending}
                    onClick={handleInvite}
                    variant="secondary"
                  >
                    Invite
                  </Button>
                </div>
              </div>
            </>
          )}
        </QueryBoundary>
      </Card>

      {/* ── Settings ── */}
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Org">Profile</CardTitle>
        </CardHeader>
        <QueryBoundary
          error={orgQuery.error}
          isError={orgQuery.isError}
          isLoading={orgQuery.isLoading}
          label="organization"
        >
          <div className="space-y-4">
            {orgError ? <Alert variant="error">{orgError}</Alert> : null}
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Name"
                onChange={(e) => setOrgName(e.target.value)}
                readOnly={!canAdmin}
                value={orgName}
              />
              <Input
                hint="Lowercase letters, numbers, hyphens"
                label="Slug"
                onChange={(e) => setOrgSlug(e.target.value)}
                readOnly={!canAdmin}
                value={orgSlug}
              />
            </div>
            {canAdmin && (
              <div className="flex justify-end">
                <Button disabled={patchOrg.isPending} onClick={handleSaveOrg} variant="primary">
                  {patchOrg.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            )}
          </div>
        </QueryBoundary>
      </Card>

      {/* ── Budget ── */}
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Billing">Monthly budget cap</CardTitle>
        </CardHeader>
        <QueryBoundary
          error={budgetQuery.error}
          isError={budgetQuery.isError}
          isLoading={budgetQuery.isLoading}
          label="budget"
        >
          <div className="space-y-4">
            {budgetError ? <Alert variant="error">{budgetError}</Alert> : null}
            {(() => {
              const cap = budget?.monthlyBudgetUsdCents ?? null;
              const threshold = budget?.budgetAlertThresholdPercent ?? null;
              const spent = budget?.currentMonthUsage?.costUsdAccrued ?? 0;
              const alert =
                cap != null && cap > 0 && threshold != null && (spent * 10000) / cap >= threshold;
              return alert ? (
                <Alert variant="warning">
                  Monthly spend is {formatCents(spent * 100)} ({formatPercent((spent * 100) / cap)}{' '}
                  of {formatCents(cap)} cap) — above the {formatPercent(threshold / 100)} alert
                  threshold.
                </Alert>
              ) : null;
            })()}
            <div className="grid grid-cols-3 gap-6">
              <Stat
                label="Current cap"
                value={
                  budget?.monthlyBudgetUsdCents != null
                    ? formatCents(budget.monthlyBudgetUsdCents)
                    : 'No cap'
                }
              />
              <Stat
                hint={
                  budget?.currentMonthUsage && (
                    <>
                      {budget.currentMonthUsage.runsCompleted} runs ·{' '}
                      {formatTokens(
                        Number(budget.currentMonthUsage.tokensInput) +
                          Number(budget.currentMonthUsage.tokensOutput)
                      )}{' '}
                      tokens
                    </>
                  )
                }
                label={`Spent this month (${budget?.currentMonthUsage?.yearMonth ?? '—'})`}
                value={formatCents((budget?.currentMonthUsage?.costUsdAccrued ?? 0) * 100)}
              />
              <Stat
                label="Alert threshold"
                value={
                  budget?.budgetAlertThresholdPercent != null
                    ? formatPercent(budget.budgetAlertThresholdPercent / 100)
                    : 'Not set'
                }
              />
            </div>
            {canAdmin && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    hint="Monthly cap in USD cents (e.g. 10000 = $100)."
                    label="Monthly cap (USD cents)"
                    onChange={(e) => setBudgetInput(e.target.value)}
                    placeholder="No cap"
                    type="number"
                    value={budgetInput}
                  />
                  <Input
                    hint="Warn when spend crosses this percent of the cap. 0-100, or blank to disable."
                    label="Alert threshold (%)"
                    onChange={(e) => setThresholdInput(e.target.value)}
                    placeholder="Not set"
                    type="number"
                    value={thresholdInput}
                  />
                </div>
                <div className="flex justify-end gap-2">
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
                    variant="primary"
                  >
                    {patchBudget.isPending ? 'Saving…' : 'Save changes'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </QueryBoundary>
      </Card>

      <ConfirmModal
        confirmLabel="Remove cap"
        dangerous
        message="Remove the monthly budget cap? Spend in this organization will no longer be limited."
        onClose={() => setConfirmRemoveCap(false)}
        onConfirm={handleRemoveCap}
        open={confirmRemoveCap}
        title="Remove budget cap"
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
        title="Remove member"
      />
    </div>
  );
}
