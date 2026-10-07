'use client';

import type { UserSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * Renders a user picker for an "add member" flow: a searchable list of eligible users,
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
        className="items-start px-0 py-2 text-left"
        hint={
          <>
            Invite one from{' '}
            <Link className="text-ember-400 hover:underline" href="/govern/users">
              Users
            </Link>{' '}
            first.
          </>
        }
        icon={null}
        title="No active users left to add"
      />
    );
  }
  return (
    <Combobox
      emptyMessage="No user matches"
      id={id}
      label={label}
      onChange={onChange}
      options={eligible.map((u) => ({ label: `${u.email} · ${u.role}`, value: u.id }))}
      placeholder="Search by email…"
      required
      value={value}
    />
  );
}
