'use client';

import type { UserSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';

/**
 * Renders a user picker for an "add member" flow: a <Select> of eligible users,
 * or a guidance message when none are left. The caller computes `eligible`
 * (typically via useEligibleUsers) so it can also drive defaulting and the
 * submit-disabled state. Shared by the teams AddMemberModal and the org page.
 */
export function EligibleUserSelect({
  eligible,
  value,
  onChange,
  label = 'User',
  id = 'user',
}: {
  eligible: UserSummary[];
  value: string;
  onChange: (userId: string) => void;
  label?: string;
  id?: string;
}) {
  if (eligible.length === 0) {
    return (
      <EmptyState
        className="py-0 text-left"
        hint={
          <>
            Invite one from{' '}
            <Link className="text-ember-400 hover:underline" href="/govern/users">
              Users
            </Link>{' '}
            first.
          </>
        }
        title="No active users left to add."
      />
    );
  }
  return (
    <Select id={id} label={label} onChange={(e) => onChange(e.target.value)} required value={value}>
      {eligible.map((u) => (
        <option key={u.id} value={u.id}>
          {u.email} · {u.role}
        </option>
      ))}
    </Select>
  );
}
