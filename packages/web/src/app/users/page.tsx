'use client';

import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { useUpdateUser, useUsers } from '@/hooks/useWorkflows';
import { cn } from '@/lib/utils';

export default function UsersPage() {
  const { data: users, isLoading } = useUsers();
  const updateUser = useUpdateUser();

  // Partition into pending (sign-ups awaiting approval) vs. active. Pending
  // users get a dedicated top section so admins notice them; the rest go
  // into the regular member table.
  const { pending, active } = useMemo(() => {
    const p: NonNullable<typeof users> = [];
    const a: NonNullable<typeof users> = [];
    for (const u of users ?? []) {
      if (u.isActive) a.push(u);
      else p.push(u);
    }
    return { active: a, pending: p };
  }, [users]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
        <span className="pulse-dot mr-3 inline-block h-1.5 w-1.5 rounded-full bg-ember-400" />
        loading users…
      </div>
    );
  }

  const handleApprove = (id: string) => updateUser.mutate({ id, patch: { isActive: true } });
  const handleSuspend = (id: string) => updateUser.mutate({ id, patch: { isActive: false } });

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <PageHeader
          chapter={`§ Users · ${(users ?? []).length} total · ${pending.length} pending`}
          subtitle="Manage who can sign in to the control plane. Sign-ups via GitHub / Google / magic link start in the pending queue and need admin approval."
          title="Members."
        />
      </div>

      {pending.length > 0 && (
        <section className="fade-up stagger-1">
          <SectionHeader
            hint={`${pending.length} awaiting approval`}
            number="01"
            title="Pending sign-ups"
          />
          <Card variant="inset">
            <ul className="divide-y divide-ink-600">
              {pending.map((u) => (
                <li className="flex items-center justify-between py-3" key={u.id}>
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400"
                    />
                    <div>
                      <div className="text-sm text-paper-100">{u.email}</div>
                      <div className="font-mono text-[11px] text-paper-500">
                        role: {u.role}
                        {u.memberships && u.memberships.length > 0 && (
                          <>
                            {' · teams: '}
                            {u.memberships
                              .map((m) => m.team?.name)
                              .filter(Boolean)
                              .join(', ')}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button
                    disabled={updateUser.isPending}
                    onClick={() => handleApprove(u.id)}
                    size="sm"
                    variant="primary"
                  >
                    {updateUser.isPending ? 'Approving…' : 'Approve →'}
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <section className={cn('fade-up', pending.length > 0 ? 'stagger-2' : 'stagger-1')}>
        <SectionHeader
          hint={`${active.length} active`}
          number={pending.length > 0 ? '02' : '01'}
          title="Active members"
        />
        <Card className="overflow-hidden p-0" variant="inset">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-600">
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Slack</Th>
                <Th>Teams</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {active.map((u) => (
                <tr className="border-b border-ink-600 last:border-b-0" key={u.id}>
                  <td className="px-4 py-3 text-sm text-paper-100">{u.email}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-sm border border-ember-400/40 bg-ember-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ember-400">
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-paper-400">
                    {u.slackId ?? <span className="text-paper-500">—</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-paper-400">
                    {(u.memberships ?? [])
                      .map((m) => m.team?.name)
                      .filter(Boolean)
                      .join(', ') || <span className="text-paper-500">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      disabled={updateUser.isPending}
                      onClick={() => handleSuspend(u.id)}
                      size="sm"
                      variant="ghost"
                    >
                      Suspend
                    </Button>
                  </td>
                </tr>
              ))}
              {active.length === 0 && (
                <tr>
                  <td
                    className="px-4 py-8 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500"
                    colSpan={5}
                  >
                    no active members
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </section>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={cn(
        'px-4 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500',
        align === 'right' ? 'text-right' : 'text-left'
      )}
    >
      {children}
    </th>
  );
}
