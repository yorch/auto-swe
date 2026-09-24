'use client';

import Link from 'next/link';
import { useState } from 'react';
import { TeamFormModal } from '@/components/teams/TeamFormModal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useHasRole } from '@/hooks/useHasRole';
import { useTeams } from '@/hooks/useTeams';

export default function TeamsPage() {
  const { data: teams, isLoading, isError, error: loadError } = useTeams();
  // POST /teams is ADMIN-only.
  const canCreate = useHasRole('ADMIN');
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)} variant="primary">
              New team
            </Button>
          )
        }
        chapter="§ Govern"
        subtitle="Teams own repositories, members, sandbox allowlists and per-team agent overrides."
        title="Teams"
      />
      <QueryBoundary error={loadError} isError={isError} isLoading={isLoading} label="teams">
        {(teams ?? []).length === 0 ? (
          <EmptyState
            hint={canCreate ? 'Create a team to group members and repositories.' : undefined}
            title="No teams yet."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(teams ?? []).map((t) => (
              <Link href={`/govern/teams/${t.id}`} key={t.id}>
                <Card className="cursor-pointer hover:border-ink-300">
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
        )}
      </QueryBoundary>
      <TeamFormModal mode={{ kind: 'create' }} onClose={() => setCreating(false)} open={creating} />
    </div>
  );
}
