'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import type { ConnectionPrefill } from '@/components/repositories/ConnectionFormModal';
import { ConnectionFormModal } from '@/components/repositories/ConnectionFormModal';
import { ImportFromGitHubModal } from '@/components/repositories/ImportFromGitHubModal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import type { GitHubRepoInfo } from '@/hooks/useRepositories';
import { useRepositories } from '@/hooks/useRepositories';
import { connectionLabel } from '@/lib/connectionDisplay';
import { useAuthStore } from '@/stores/authStore';

type ModalMode =
  | { kind: 'create'; prefill?: ConnectionPrefill }
  | { kind: 'edit'; repo: RepositorySummary }
  | { kind: 'import' }
  | null;

const TYPE_LABELS: Record<string, string> = {
  api_endpoint: 'REST API',
  generic: 'Generic',
  git_repo: 'Git repo',
};

function ConnectionTypeBadge({ type }: { type: string }) {
  const label = TYPE_LABELS[type] ?? type;
  const colors =
    type === 'git_repo'
      ? 'bg-moss-400/10 text-moss-400 border-moss-400/30'
      : type === 'api_endpoint'
        ? 'bg-violet-400/10 text-violet-400 border-violet-400/30'
        : 'bg-amber-400/10 text-amber-400 border-amber-400/30';
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${colors}`}
    >
      {label}
    </span>
  );
}

export default function ConnectionsPage() {
  const { data: repos, isLoading } = useRepositories();
  const role = useAuthStore((s) => s.user?.role ?? 'ENGINEER');
  const canManage = role === 'ADMIN' || role === 'LEAD';
  const [mode, setMode] = useState<ModalMode>(null);

  if (isLoading) {
    return <LoadingState />;
  }

  function handleImportSelect(repo: GitHubRepoInfo) {
    setMode({
      kind: 'create',
      prefill: {
        defaultBranch: repo.defaultBranch,
        description: repo.description ?? undefined,
        githubApiUrl: repo.apiUrl,
        githubUrl: repo.htmlUrl,
        language: repo.language ?? undefined,
        organizationName: repo.org,
        repoName: repo.name,
      },
    });
  }

  const formMode = mode?.kind === 'create' || mode?.kind === 'edit' ? mode : null;

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          canManage ? (
            <div className="flex items-center gap-2">
              <Button onClick={() => setMode({ kind: 'import' })} size="sm" variant="secondary">
                Import from GitHub
              </Button>
              <Button onClick={() => setMode({ kind: 'create' })} size="sm" variant="primary">
                + Add connection
              </Button>
            </div>
          ) : undefined
        }
        chapter="§ Library"
        subtitle="External systems — git repos, REST APIs, and other integrations — available to your workflows."
        title="Connections."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {(repos ?? []).map((r) => (
          <Card key={r.id}>
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 truncate font-semibold">{connectionLabel(r)}</h3>
              <ConnectionTypeBadge type={r.type ?? 'git_repo'} />
            </div>
            <div className="mt-2 space-y-1 text-sm text-paper-400">
              {(!r.type || r.type === 'git_repo') && <p>Branch: {r.defaultBranch}</p>}
              <p>Team: {r.team?.name ?? 'None'}</p>
              <p>Workflows: {r._count?.activeWorkflows ?? 0}</p>
              {(!r.type || r.type === 'git_repo') && <p>Image: {r.executorImage ?? 'default'}</p>}
              {r.description && <p className="truncate text-xs">{r.description}</p>}
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
          <p className="col-span-full py-12 text-center text-sm text-paper-400">
            No connections yet.
            {canManage
              ? ' Use "Import from GitHub" or "Add connection" above.'
              : ' Ask a team lead or admin to add one.'}
          </p>
        )}
      </div>

      <ImportFromGitHubModal
        onClose={() =>
          // Functional update so that if onSelect already transitioned mode to
          // 'create', the dialog's programmatic close event doesn't overwrite it.
          setMode((prev) => (prev?.kind === 'create' ? prev : null))
        }
        onSelect={handleImportSelect}
        open={mode?.kind === 'import'}
      />

      {formMode && <ConnectionFormModal mode={formMode} onClose={() => setMode(null)} open />}
    </div>
  );
}
