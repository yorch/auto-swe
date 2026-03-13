'use client';

import { use } from 'react';
import { useTeam } from '@/hooks/useWorkflows';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import Link from 'next/link';

export default function TeamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: team, isLoading } = useTeam(id);

  if (isLoading) return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading...</div>;
  if (!team) return <div className="text-center py-12 text-[var(--muted-foreground)]">Team not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/teams" className="text-[var(--primary)] hover:underline text-sm">&larr; Back</Link>
        <h2 className="text-2xl font-bold">{team.name}</h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Members ({team.memberships?.length ?? 0})</CardTitle></CardHeader>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="text-left py-2">Email</th>
                <th className="text-left py-2">Platform Role</th>
                <th className="text-left py-2">Team Role</th>
              </tr>
            </thead>
            <tbody>
              {(team.memberships ?? []).map((m) => (
                <tr key={m.id} className="border-b border-[var(--border)]">
                  <td className="py-2">{m.user?.email}</td>
                  <td className="py-2 text-[var(--muted-foreground)]">{m.user?.role}</td>
                  <td className="py-2">{m.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card>
          <CardHeader><CardTitle>Repositories ({team.repositories?.length ?? 0})</CardTitle></CardHeader>
          <div className="space-y-2">
            {(team.repositories ?? []).map((r) => (
              <div key={r.id} className="flex items-center justify-between text-sm p-2 rounded hover:bg-[var(--muted)]">
                <span className="font-medium">{r.organizationName}/{r.repoName}</span>
                <span className={`text-xs ${r.isActive ? 'text-[var(--success)]' : 'text-[var(--muted-foreground)]'}`}>
                  {r.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
