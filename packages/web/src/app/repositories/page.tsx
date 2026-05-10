'use client';

import { Card } from '@/components/ui/Card';
import { useRepositories } from '@/hooks/useWorkflows';

export default function RepositoriesPage() {
  const { data: repos, isLoading } = useRepositories();

  if (isLoading)
    return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Repositories</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(repos ?? []).map((r) => (
          <Card key={r.id}>
            <h3 className="font-semibold">
              {r.organizationName}/{r.repoName}
            </h3>
            <div className="mt-2 text-sm text-[var(--muted-foreground)] space-y-1">
              <p>Branch: {r.defaultBranch}</p>
              <p>Team: {r.team?.name ?? 'None'}</p>
              <p>Workflows: {r._count?.activeWorkflows ?? 0}</p>
              <p>Image: {r.executorImage ?? 'default'}</p>
            </div>
            <div className="mt-3">
              <span
                className={`text-xs font-medium ${r.isActive ? 'text-[var(--success)]' : 'text-[var(--destructive)]'}`}
              >
                {r.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
