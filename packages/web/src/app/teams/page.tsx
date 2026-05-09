'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { useTeams } from '@/hooks/useWorkflows';

export default function TeamsPage() {
  const { data: teams, isLoading } = useTeams();

  if (isLoading)
    return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Teams</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(teams ?? []).map((t) => (
          <Link key={t.id} href={`/teams/${t.id}`}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer">
              <h3 className="font-semibold text-lg">{t.name}</h3>
              <p className="text-sm text-[var(--muted-foreground)] mt-1">
                {t.description || 'No description'}
              </p>
              <div className="flex gap-4 mt-4 text-xs text-[var(--muted-foreground)]">
                <span>{t._count?.memberships ?? 0} members</span>
                <span>{t._count?.repositories ?? 0} repos</span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
