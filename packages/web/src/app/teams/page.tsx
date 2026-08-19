'use client';

import Link from 'next/link';
import { useState } from 'react';
import { TeamFormModal } from '@/components/teams/TeamFormModal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { useTeams } from '@/hooks/useTeams';
import { useAuthStore } from '@/stores/authStore';

export default function TeamsPage() {
  const { data: teams, isLoading } = useTeams();
  const role = useAuthStore((s) => s.user?.role ?? 'ENGINEER');
  const canCreate = role === 'ADMIN';
  const [creating, setCreating] = useState(false);

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-bold">Teams</h2>
        {canCreate && (
          <Button onClick={() => setCreating(true)} variant="primary">
            + New team
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(teams ?? []).map((t) => (
          <Link href={`/teams/${t.id}`} key={t.id}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer">
              <h3 className="font-semibold text-lg">{t.name}</h3>
              <p className="text-sm text-paper-400 mt-1">{t.description || 'No description'}</p>
              <div className="flex gap-4 mt-4 text-xs text-paper-400">
                <span>{t._count?.memberships ?? 0} members</span>
                <span>{t._count?.repositories ?? 0} repos</span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
      <TeamFormModal mode={{ kind: 'create' }} onClose={() => setCreating(false)} open={creating} />
    </div>
  );
}
