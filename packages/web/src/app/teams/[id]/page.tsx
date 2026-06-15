'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { AddMemberModal } from '@/components/teams/AddMemberModal';
import { EgressAllowlistEditor } from '@/components/teams/EgressAllowlistEditor';
import { ShellAllowlistEditor } from '@/components/teams/ShellAllowlistEditor';
import { TeamFormModal } from '@/components/teams/TeamFormModal';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { LoadingState } from '@/components/ui/LoadingState';
import { Select } from '@/components/ui/Select';
import { useRemoveTeamMember, useTeam, useUpdateTeamMember } from '@/hooks/useWorkflows';
import { useAuthStore } from '@/stores/authStore';

type Role = 'ADMIN' | 'LEAD' | 'ENGINEER';

export default function TeamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: team, isLoading } = useTeam(id);
  const updateMember = useUpdateTeamMember(id);
  const removeMember = useRemoveTeamMember(id);
  const platformRole = useAuthStore((s) => s.user?.role ?? 'ENGINEER');
  const userId = useAuthStore((s) => s.user?.sub ?? null);
  const canManage = platformRole === 'ADMIN' || platformRole === 'LEAD';
  // The model-config team-scoped endpoints require team-ADMIN role (or
  // platform ADMIN as bypass). Compute the user's actual team-role here so
  // we don't render a section that 403s on every API call. Platform LEAD
  // without a team-ADMIN membership sees nothing.
  const ownTeamRole = team?.memberships?.find((m) => m.user?.id === userId)?.role;
  const canManageTeamConfig = platformRole === 'ADMIN' || ownTeamRole === 'ADMIN';

  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmRemoveEmail, setConfirmRemoveEmail] = useState<string | null>(null);

  if (isLoading) {
    return <LoadingState />;
  }
  if (!team) {
    return <div className="text-center py-12 text-paper-400">Team not found</div>;
  }

  const memberships = team.memberships ?? [];
  const existingUserIds = memberships.map((m) => m.user?.id ?? '').filter(Boolean);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link className="text-ember-400 hover:underline text-sm" href="/teams">
            &larr; Teams
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
              <tr className="border-b border-ink-600">
                <th className="text-left py-2">Email</th>
                <th className="text-left py-2">Platform Role</th>
                <th className="text-left py-2">Team Role</th>
                {canManage && <th className="py-2" />}
              </tr>
            </thead>
            <tbody>
              {memberships.map((m) => (
                <tr className="border-b border-ink-600" key={m.id}>
                  <td className="py-2">{m.user?.email}</td>
                  <td className="py-2 text-paper-400">{m.user?.role}</td>
                  <td className="py-2">
                    {canManage && m.user?.id ? (
                      <Select
                        className="h-7 w-auto px-2 text-xs"
                        onChange={(e) =>
                          m.user?.id &&
                          updateMember.mutate({
                            role: e.target.value as Role,
                            userId: m.user.id,
                          })
                        }
                        value={m.role}
                      >
                        <option value="ENGINEER">ENGINEER</option>
                        <option value="LEAD">LEAD</option>
                        <option value="ADMIN">ADMIN</option>
                      </Select>
                    ) : (
                      m.role
                    )}
                  </td>
                  {canManage && (
                    <td className="py-2 text-right">
                      {m.user?.id && (
                        <Button
                          disabled={removeMember.isPending}
                          onClick={() => {
                            if (m.user?.id) {
                              setConfirmRemoveId(m.user.id);
                              setConfirmRemoveEmail(m.user.email ?? null);
                            }
                          }}
                          size="sm"
                          variant="danger"
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {memberships.length === 0 && (
                <tr>
                  <td
                    className="py-4 text-center text-xs text-paper-500"
                    colSpan={canManage ? 4 : 3}
                  >
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
                className="flex items-center justify-between text-sm p-2 rounded hover:bg-ink-800"
                key={r.id}
              >
                <span className="font-medium">
                  {r.organizationName}/{r.repoName}
                </span>
                <span className={`text-xs ${r.isActive ? 'text-moss-400' : 'text-paper-400'}`}>
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

      {canManageTeamConfig && <ShellAllowlistEditor teamId={id} />}
      {canManageTeamConfig && <EgressAllowlistEditor teamId={id} />}

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
      <ConfirmModal
        confirmLabel="Remove"
        dangerous
        message={`Remove ${confirmRemoveEmail ?? 'this user'} from ${team.name}?`}
        onClose={() => {
          setConfirmRemoveId(null);
          setConfirmRemoveEmail(null);
        }}
        onConfirm={() => {
          if (confirmRemoveId) {
            removeMember.mutate(confirmRemoveId);
          }
        }}
        open={confirmRemoveId !== null}
        title="Remove member"
      />
    </div>
  );
}
