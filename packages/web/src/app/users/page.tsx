'use client';

import { Card } from '@/components/ui/Card';
import { useUsers } from '@/hooks/useWorkflows';

export default function UsersPage() {
  const { data: users, isLoading } = useUsers();

  if (isLoading)
    return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Users</h2>
      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--muted)]">
              <th className="text-left px-4 py-3 font-medium">Email</th>
              <th className="text-left px-4 py-3 font-medium">Role</th>
              <th className="text-left px-4 py-3 font-medium">Slack ID</th>
              <th className="text-left px-4 py-3 font-medium">Teams</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr className="border-b border-[var(--border)]" key={u.id}>
                <td className="px-4 py-3">{u.email}</td>
                <td className="px-4 py-3">{u.role}</td>
                <td className="px-4 py-3 text-[var(--muted-foreground)]">{u.slackId ?? '-'}</td>
                <td className="px-4 py-3 text-[var(--muted-foreground)]">
                  {(u.memberships ?? [])
                    .map((m) => m.team?.name)
                    .filter(Boolean)
                    .join(', ') || '-'}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={u.isActive ? 'text-[var(--success)]' : 'text-[var(--destructive)]'}
                  >
                    {u.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
