'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { EligibleUserSelect } from '@/components/EligibleUserSelect';
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
import { useEligibleUsers } from '@/hooks/useUsers';
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
  const [budgetInput, setBudgetInput] = useState('');
  const [thresholdInput, setThresholdInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{ userId: string; email: string } | null>(
    null
  );

  // Only offer active users who aren't already members for the add picker.
  const eligibleUsers = useEligibleUsers((members ?? []).map((m) => m.userId));

  // The selected user, falling back to the first eligible one. Derived (not
  // stored) so the controlled <Select> and the submit handler always agree even
  // if a refetch drops the previously-picked user from `eligibleUsers`.
  const effectiveUserId =
    addUserId && eligibleUsers.some((u) => u.id === addUserId)
      ? addUserId
      : (eligibleUsers[0]?.id ?? '');

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
    if (!effectiveUserId) {
      setError('Pick a user to add');
      return;
    }
    try {
      await upsertMember.mutateAsync({ role: addRole, userId: effectiveUserId });
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

  async function handleSaveBudget() {
    setBudgetError(null);
    const val = budgetInput.trim();
    const cents = val === '' ? null : Number(val);
    if (cents !== null && (!Number.isInteger(cents) || cents < 0)) {
      setBudgetError('Enter a non-negative integer (USD cents), or leave blank to remove the cap');
      return;
    }
    const tval = thresholdInput.trim();
    const threshold = tval === '' ? null : Number(tval);
    if (threshold !== null && (!Number.isInteger(threshold) || threshold < 0 || threshold > 100)) {
      setBudgetError('Alert threshold must be an integer between 0 and 100');
      return;
    }
    try {
      await patchBudget.mutateAsync({
        budgetAlertThresholdPercent: threshold,
        monthlyBudgetUsdCents: cents,
      });
      setBudgetInput('');
      setThresholdInput('');
    } catch (e) {
      setBudgetError(errMsg(e, 'Failed to update budget'));
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
                        disabled={isMe}
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
                      <Button
                        disabled={isMe}
                        onClick={() => setPendingRemoval({ email: m.user.email, userId: m.userId })}
                        size="sm"
                        variant="danger"
                      >
                        Remove
                      </Button>
                    </Td>
                  </TRow>
                );
              })}
            </tbody>
          </Table>
          <div className="mt-4 flex items-end gap-3 border-t border-ink-600 pt-4">
            <EligibleUserSelect
              eligible={eligibleUsers}
              label="Add user"
              onChange={setAddUserId}
              value={effectiveUserId}
            />
            {eligibleUsers.length > 0 && (
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
              <Button disabled={inviteMember.isPending} onClick={handleInvite} variant="secondary">
                Invite
              </Button>
            </div>
          </div>
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
              <Input label="Name" onChange={(e) => setOrgName(e.target.value)} value={orgName} />
              <Input
                hint="Lowercase letters, numbers, hyphens"
                label="Slug"
                onChange={(e) => setOrgSlug(e.target.value)}
                value={orgSlug}
              />
            </div>
            <div className="flex justify-end">
              <Button disabled={patchOrg.isPending} onClick={handleSaveOrg} variant="primary">
                {patchOrg.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
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
              <div>
                <Stat
                  label={`Spent this month (${budget?.currentMonthUsage?.yearMonth ?? '—'})`}
                  value={formatCents((budget?.currentMonthUsage?.costUsdAccrued ?? 0) * 100)}
                />
                {budget?.currentMonthUsage && (
                  <p className="mt-1 pl-5 text-[11px] text-paper-500">
                    {budget.currentMonthUsage.runsCompleted} runs ·{' '}
                    {formatTokens(
                      Number(budget.currentMonthUsage.tokensInput) +
                        Number(budget.currentMonthUsage.tokensOutput)
                    )}{' '}
                    tokens
                  </p>
                )}
              </div>
              <Stat
                label="Alert threshold"
                value={
                  budget?.budgetAlertThresholdPercent != null
                    ? formatPercent(budget.budgetAlertThresholdPercent / 100)
                    : 'Not set'
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input
                hint="Monthly cap in USD cents (e.g. 10000 = $100). Leave blank to remove the cap."
                label="Set new cap (USD cents)"
                onChange={(e) => setBudgetInput(e.target.value)}
                placeholder={String(budget?.monthlyBudgetUsdCents ?? '')}
                type="number"
                value={budgetInput}
              />
              <Input
                hint="Warn when spend crosses this percent of the cap. 0-100, or blank to disable."
                label="Alert threshold (%)"
                onChange={(e) => setThresholdInput(e.target.value)}
                placeholder={String(budget?.budgetAlertThresholdPercent ?? '')}
                type="number"
                value={thresholdInput}
              />
            </div>
            <div className="flex justify-end">
              <Button disabled={patchBudget.isPending} onClick={handleSaveBudget} variant="primary">
                {patchBudget.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        </QueryBoundary>
      </Card>

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
