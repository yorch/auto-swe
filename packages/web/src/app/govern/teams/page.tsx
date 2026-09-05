'use client';

import Link from 'next/link';
import { useState } from 'react';
import { TeamFormModal } from '@/components/teams/TeamFormModal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useTeams } from '@/hooks/useTeams';
import { useAuthStore } from '@/stores/authStore';

export default function TeamsPage() {
  const { data: teams, isLoading, isError, error: loadError } = useTeams();
  const role = useAuthStore((s) => s.user?.role ?? 'ENGINEER');
  const canCreate = role === 'ADMIN';
  const [creating, setCreating] = useState(false);

  if (isLoading || isError) {
    return (
      <QueryBoundary error={loadError} isError={isError} isLoading={isLoading} label="teams" />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)} variant="primary">
              + New team
            </Button>
          )
        }
        chapter="§ Teams"
        title="Teams"
      />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(teams ?? []).map((t) => (
          <Link href={`/govern/teams/${t.id}`} key={t.id}>
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
