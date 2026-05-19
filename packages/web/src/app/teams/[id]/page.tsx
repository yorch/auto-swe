'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { AddMemberModal } from '@/components/teams/AddMemberModal';
import { ShellAllowlistEditor } from '@/components/teams/ShellAllowlistEditor';
import { TeamFormModal } from '@/components/teams/TeamFormModal';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useTeam, useUpdateTeamMember } from '@/hooks/useWorkflows';
import { useAuthStore } from '@/stores/authStore';

type Role = 'ADMIN' | 'LEAD' | 'ENGINEER';

export default function TeamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: team, isLoading } = useTeam(id);
  const updateMember = useUpdateTeamMember(id);
  const platformRole = useAuthStore((s) => s.user?.role ?? 'ENGINEER');
  const canManage = platformRole === 'ADMIN' || platformRole === 'LEAD';

  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);

  if (isLoading)
    return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading...</div>;
  if (!team)
    return <div className="text-center py-12 text-[var(--muted-foreground)]">Team not found</div>;

  const memberships = team.memberships ?? [];
  const existingUserIds = memberships.map((m) => m.user?.id ?? '').filter(Boolean);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link className="text-[var(--primary)] hover:underline text-sm" href="/teams">
            &larr; Back
          </Link>
          <h2 className="text-2xl font-bold">{team.name}</h2>
        </div>
        {canManage && (
          <Button onClick={() => setEditing(true)} size="sm" variant="ghost">
            Edit team
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Members ({memberships.length})</CardTitle>
            {canManage && (
              <Button onClick={() => setAdding(true)} size="sm" variant="primary">
                + Add
              </Button>
            )}
          </CardHeader>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="text-left py-2">Email</th>
                <th className="text-left py-2">Platform Role</th>
                <th className="text-left py-2">Team Role</th>
              </tr>
            </thead>
            <tbody>
              {memberships.map((m) => (
                <tr className="border-b border-[var(--border)]" key={m.id}>
                  <td className="py-2">{m.user?.email}</td>
                  <td className="py-2 text-[var(--muted-foreground)]">{m.user?.role}</td>
                  <td className="py-2">
                    {canManage && m.user?.id ? (
                      <select
                        className="h-7 rounded-sm border border-ink-500 bg-ink-900/60 px-2 text-xs"
                        defaultValue={m.role}
                        onChange={(e) =>
                          m.user?.id &&
                          updateMember.mutate({
                            role: e.target.value as Role,
                            userId: m.user.id,
                          })
                        }
                      >
                        <option value="ENGINEER">ENGINEER</option>
                        <option value="LEAD">LEAD</option>
                        <option value="ADMIN">ADMIN</option>
                      </select>
                    ) : (
                      m.role
                    )}
                  </td>
                </tr>
              ))}
              {memberships.length === 0 && (
                <tr>
                  <td className="py-4 text-center text-xs text-paper-500" colSpan={3}>
                    No members yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Repositories ({team.repositories?.length ?? 0})</CardTitle>
          </CardHeader>
          <div className="space-y-2">
            {(team.repositories ?? []).map((r) => (
              <div
                className="flex items-center justify-between text-sm p-2 rounded hover:bg-[var(--muted)]"
                key={r.id}
              >
                <span className="font-medium">
                  {r.organizationName}/{r.repoName}
                </span>
                <span
                  className={`text-xs ${r.isActive ? 'text-[var(--success)]' : 'text-[var(--muted-foreground)]'}`}
                >
                  {r.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
            ))}
            {(team.repositories ?? []).length === 0 && (
              <p className="py-4 text-center text-xs text-paper-500">
                No repositories yet. Add one from{' '}
                <Link className="text-ember-400 hover:underline" href="/repositories">
                  Repositories
                </Link>
                .
              </p>
            )}
          </div>
        </Card>
      </div>

      {canManage && <ShellAllowlistEditor teamId={id} />}

      <TeamFormModal
        mode={{
          initial: { description: team.description, name: team.name },
          kind: 'edit',
          teamId: id,
        }}
        onClose={() => setEditing(false)}
        open={editing}
      />
      <AddMemberModal
        existingUserIds={existingUserIds}
        onClose={() => setAdding(false)}
        open={adding}
        teamId={id}
      />
    </div>
  );
}
