'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { RepositoryFormModal } from '@/components/repositories/RepositoryFormModal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { useRepositories } from '@/hooks/useWorkflows';
import { useAuthStore } from '@/stores/authStore';

type ModalMode = { kind: 'create' } | { kind: 'edit'; repo: RepositorySummary } | null;

export default function RepositoriesPage() {
  const { data: repos, isLoading } = useRepositories();
  const role = useAuthStore((s) => s.user?.role ?? 'ENGINEER');
  const canManage = role === 'ADMIN' || role === 'LEAD';
  const [mode, setMode] = useState<ModalMode>(null);

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          canManage ? (
            <Button onClick={() => setMode({ kind: 'create' })} size="sm" variant="primary">
              + Add connection
            </Button>
          ) : undefined
        }
        chapter="§ Library"
        subtitle="Git repositories and other integrations available to your workflows."
        title="Connections."
      />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(repos ?? []).map((r) => (
          <Card key={r.id}>
            <h3 className="font-semibold">
              {r.organizationName}/{r.repoName}
            </h3>
            <div className="mt-2 text-sm text-paper-400 space-y-1">
              <p>Branch: {r.defaultBranch}</p>
              <p>Team: {r.team?.name ?? 'None'}</p>
              <p>Workflows: {r._count?.activeWorkflows ?? 0}</p>
              <p>Image: {r.executorImage ?? 'default'}</p>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span
                className={`text-xs font-medium ${r.isActive ? 'text-moss-400' : 'text-brick-400'}`}
              >
                {r.isActive ? 'Active' : 'Inactive'}
              </span>
              {canManage && (
                <Button
                  onClick={() => setMode({ kind: 'edit', repo: r })}
                  size="sm"
                  variant="ghost"
                >
                  Edit
                </Button>
              )}
            </div>
          </Card>
        ))}
        {(repos ?? []).length === 0 && (
          <p className="col-span-full text-center text-sm text-paper-400 py-12">
            No connections yet.
            {canManage
              ? ' Use "Add connection" above to connect a repository.'
              : ' Ask a team lead or admin to add one.'}
          </p>
        )}
      </div>
      {mode && (
        <RepositoryFormModal mode={mode} onClose={() => setMode(null)} open={mode !== null} />
      )}
    </div>
  );
}
