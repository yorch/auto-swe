'use client';

import { use, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Select } from '@/components/ui/Select';
import {
  type OrgRole,
  useOrgBudget,
  useOrgMembers,
  usePatchOrgBudget,
  usePatchOrgMember,
  useRemoveOrgMember,
  useUpsertOrgMember,
} from '@/hooks/useOrg';
import { useUsers } from '@/hooks/useUsers';

export default function OrgAdminPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);

  const { data: members, isLoading: membersLoading } = useOrgMembers(orgId);
  const { data: budget, isLoading: budgetLoading } = useOrgBudget(orgId);
  const { data: users = [] } = useUsers();
  const upsertMember = useUpsertOrgMember(orgId);
  const patchMember = usePatchOrgMember(orgId);
  const removeMember = useRemoveOrgMember(orgId);
  const patchBudget = usePatchOrgBudget(orgId);

  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<OrgRole>('ORG_MEMBER');
  const [budgetInput, setBudgetInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{ userId: string; email: string } | null>(
    null
  );

  // Only offer active users who aren't already members for the add picker.
  const eligibleUsers = useMemo(() => {
    const memberIds = new Set((members ?? []).map((m) => m.userId));
    return users.filter((u) => u.isActive && !memberIds.has(u.id));
  }, [users, members]);

  async function handleAddMember() {
    setError(null);
    const userId = addUserId || eligibleUsers[0]?.id;
    if (!userId) {
      setError('Pick a user to add');
      return;
    }
    try {
      await upsertMember.mutateAsync({ role: addRole, userId });
      setAddUserId('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add member');
    }
  }

  async function handleRoleChange(userId: string, role: OrgRole) {
    setError(null);
    try {
      await patchMember.mutateAsync({ role, userId });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update role');
    }
  }

  async function handleRemove(userId: string) {
    setError(null);
    try {
      await removeMember.mutateAsync(userId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove member');
    }
  }

  async function handleSaveBudget() {
    setBudgetError(null);
    const val = budgetInput.trim();
    const cents = val === '' ? null : Number(val);
    if (cents !== null && (Number.isNaN(cents) || cents < 0)) {
      setBudgetError('Enter a non-negative integer (USD cents), or leave blank to remove the cap');
      return;
    }
    try {
      await patchBudget.mutateAsync(cents);
      setBudgetInput('');
    } catch (e) {
      setBudgetError(e instanceof Error ? e.message : 'Failed to update budget');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Organization Settings</h2>
        <p className="mt-1 font-mono text-xs text-paper-500">{orgId}</p>
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
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-600 text-left text-xs text-paper-500">
                  <th className="py-2 pr-3">Email</th>
                  <th className="py-2 pr-3">Platform role</th>
                  <th className="py-2 pr-3">Org role</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {(members ?? []).map((m) => (
                  <tr className="border-b border-ink-600 last:border-0" key={m.id}>
                    <td className="py-3 pr-3 text-paper-100">{m.user.email}</td>
                    <td className="py-3 pr-3 font-mono text-[11px] text-paper-400">
                      {m.user.role}
                    </td>
                    <td className="py-3 pr-3">
                      <Select
                        onChange={(e) => handleRoleChange(m.userId, e.target.value as OrgRole)}
                        value={m.role}
                      >
                        <option value="ORG_ADMIN">ORG_ADMIN</option>
                        <option value="ORG_MEMBER">ORG_MEMBER</option>
                      </Select>
                    </td>
                    <td className="py-3 text-right">
                      <Button
                        onClick={() => setPendingRemoval({ email: m.user.email, userId: m.userId })}
                        size="sm"
                        variant="ghost"
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 flex items-end gap-3 border-t border-ink-600 pt-4">
              {eligibleUsers.length === 0 ? (
                <p className="text-xs text-paper-500">
                  No active non-member users left to add. Invite one from{' '}
                  <span className="text-paper-200">/users</span> first.
                </p>
              ) : (
                <>
                  <Select
                    label="Add user"
                    onChange={(e) => setAddUserId(e.target.value)}
                    value={addUserId || eligibleUsers[0]?.id}
                  >
                    {eligibleUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.email} · {u.role}
                      </option>
                    ))}
                  </Select>
                  <Select
                    label="Role"
                    onChange={(e) => setAddRole(e.target.value as OrgRole)}
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
          </>
        )}
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
            <div className="grid grid-cols-2 gap-6 text-sm">
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
            </div>
            <div className="flex items-end gap-3">
              <Input
                hint="Monthly cap in USD cents (e.g. 10000 = $100). Leave blank to remove the cap."
                label="Set new cap (USD cents)"
                onChange={(e) => setBudgetInput(e.target.value)}
                placeholder={String(budget?.monthlyBudgetUsdCents ?? '')}
                type="number"
                value={budgetInput}
              />
              <Button disabled={patchBudget.isPending} onClick={handleSaveBudget} variant="primary">
                Save
              </Button>
            </div>
          </div>
        )}
      </Card>

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
