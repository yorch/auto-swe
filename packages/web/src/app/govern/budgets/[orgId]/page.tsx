'use client';

import { use, useEffect, useState } from 'react';
import { MemberUserPicker } from '@/components/MemberUserPicker';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Table } from '@/components/ui/Table';
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
import { useAuthStore } from '@/stores/authStore';

const ORG_ROLES: readonly OrgRole[] = ['ORG_MEMBER', 'ORG_ADMIN'];

function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

export default function OrgAdminPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId: rawOrgId } = use(params);
  const orgId = validateRouteParam(rawOrgId);

  const { data: members, isLoading: membersLoading } = useOrgMembers(orgId ?? '');
  const { data: budget, isLoading: budgetLoading } = useOrgBudget(orgId ?? '');
  const { data: org } = useOrg(orgId ?? '');
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
    return <div className="text-center py-12 text-paper-400">Organization not found</div>;
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

  async function handleRemove(userId: string) {
    setError(null);
    try {
      await removeMember.mutateAsync(userId);
    } catch (e) {
      setError(errMsg(e, 'Failed to remove member'));
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
    <div className="space-y-6">
      <div>
        <PageHeader className="mb-3" title="Organization settings" />
        <p className="font-mono text-xs text-paper-500">{orgId}</p>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {/* ── Members ── */}
      <Card>
        <CardHeader>
          <CardTitle eyebrow="RBAC">Members</CardTitle>
        </CardHeader>
        {membersLoading ? (
          <LoadingState />
        ) : (
          <>
            <Table>
              <thead>
                <tr className="border-b border-ink-600 text-left text-xs text-paper-500">
                  <th className="py-2 pr-3">Email</th>
                  <th className="py-2 pr-3">Platform role</th>
                  <th className="py-2 pr-3">Org role</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {(members ?? []).map((m) => {
                  const isMe = m.userId === authUserId;
                  return (
                    <tr className="border-b border-ink-600 last:border-0" key={m.id}>
                      <td className="py-3 pr-3 text-paper-100">
                        {m.user.email} {isMe ? <span className="text-paper-500">(you)</span> : null}
                      </td>
                      <td className="py-3 pr-3 font-mono text-[11px] text-paper-400">
                        {m.user.role}
                      </td>
                      <td className="py-3 pr-3">
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
                      </td>
                      <td className="py-3 text-right">
                        {canAdmin && (
                          <Button
                            disabled={isMe}
                            onClick={() =>
                              setPendingRemoval({ email: m.user.email, userId: m.userId })
                            }
                            size="sm"
                            variant="ghost"
                          >
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
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
          </>
        )}
      </Card>

      {/* ── Settings ── */}
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Org">Profile</CardTitle>
        </CardHeader>
        <div className="space-y-4 p-4 pt-0">
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
                {patchOrg.isPending ? 'Saving…' : 'Save Profile'}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* ── Budget ── */}
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Billing">Monthly Budget Cap</CardTitle>
        </CardHeader>
        {budgetLoading ? (
          <LoadingState />
        ) : (
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
                  Monthly spend is ${spent.toFixed(2)} ({((spent * 100) / (cap / 100)).toFixed(1)}%
                  of ${(cap / 100).toFixed(2)} cap) — above the {threshold}% alert threshold.
                </Alert>
              ) : null;
            })()}
            <div className="grid grid-cols-3 gap-6 text-sm">
              <div>
                <p className="text-paper-500">Current cap</p>
                <p className="mt-1 text-lg font-semibold">
                  {budget?.monthlyBudgetUsdCents != null
                    ? `$${(budget.monthlyBudgetUsdCents / 100).toFixed(2)}`
                    : 'No cap'}
                </p>
              </div>
              <div>
                <p className="text-paper-500">
                  Spent this month ({budget?.currentMonthUsage?.yearMonth ?? '—'})
                </p>
                <p className="mt-1 text-lg font-semibold">
                  {budget?.currentMonthUsage
                    ? `$${budget.currentMonthUsage.costUsdAccrued.toFixed(4)}`
                    : '$0.00'}
                </p>
                {budget?.currentMonthUsage && (
                  <p className="mt-0.5 text-[11px] text-paper-500">
                    {budget.currentMonthUsage.runsCompleted} runs ·{' '}
                    {(
                      (Number(budget.currentMonthUsage.tokensInput) +
                        Number(budget.currentMonthUsage.tokensOutput)) /
                      1_000_000
                    ).toFixed(2)}
                    M tokens
                  </p>
                )}
              </div>
              <div>
                <p className="text-paper-500">Alert threshold</p>
                <p className="mt-1 text-lg font-semibold">
                  {budget?.budgetAlertThresholdPercent != null
                    ? `${budget.budgetAlertThresholdPercent}%`
                    : 'Not set'}
                </p>
              </div>
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
                    {patchBudget.isPending ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
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
        onConfirm={() => {
          if (pendingRemoval) {
            handleRemove(pendingRemoval.userId);
          }
        }}
        open={pendingRemoval !== null}
        title="Remove member"
      />
    </div>
  );
}
