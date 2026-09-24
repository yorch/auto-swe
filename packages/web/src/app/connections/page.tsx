'use client';

import { getConnectionTypeMetadata, isConnectionType } from '@auto-swe/shared/lib/connectionTypes';
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useCallback, useState } from 'react';
import type { ConnectionPrefill } from '@/components/repositories/ConnectionFormModal';
import { ConnectionFormModal } from '@/components/repositories/ConnectionFormModal';
import { ImportFromGitHubModal } from '@/components/repositories/ImportFromGitHubModal';
import { RepoDependenciesModal } from '@/components/repositories/RepoDependenciesModal';
import { RepoDependencySuggestions } from '@/components/repositories/RepoDependencySuggestions';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useHasRole } from '@/hooks/useHasRole';
import {
  useRepoDependencySuggestions,
  useTriggerRepoDependencyScan,
} from '@/hooks/useRepoDependencies';
import type { GitHubRepoInfo } from '@/hooks/useRepositories';
import { useRepositories } from '@/hooks/useRepositories';
import { useLedTeamIds } from '@/hooks/useTeams';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';
import { hostOverridesFromRepoUrls } from '@/lib/githubHost';
import { navLabel } from '@/lib/navigation';
import { canWriteTeamResource } from '@/lib/teamPermissions';
import { useAuthStore } from '@/stores/authStore';

type ModalMode =
  | { kind: 'create'; prefill?: ConnectionPrefill }
  | { kind: 'edit'; repo: RepositorySummary }
  | { kind: 'dependencies'; repo: RepositorySummary }
  | { kind: 'import' }
  | null;

function ConnectionTypeBadge({ type }: { type: string }) {
  const label = isConnectionType(type) ? getConnectionTypeMetadata(type).label : type;
  const tone: BadgeTone = type === 'git_repo' ? 'moss' : type === 'http_api' ? 'violet' : 'amber';
  return (
    <Badge className="text-[9px]" tone={tone} uppercase variant="outline">
      {label}
    </Badge>
  );
}

export default function ConnectionsPage() {
  // Connection writes are LEAD routes that also require LEAD membership on the
  // connection's team (canManageTeamRepos); a platform ADMIN bypasses that.
  // `canManage` gates the page-level controls — add, import, show inactive —
  // which need at least one led team; each row gates on its own team.
  const isLead = useHasRole('LEAD');
  const isAdmin = useHasRole('ADMIN');
  const platformRole = useAuthStore((s) => s.user?.role);
  const ledTeamIds = useLedTeamIds();
  const canManageTeam = useCallback(
    (teamId: string | null | undefined) => canWriteTeamResource(platformRole, teamId, ledTeamIds),
    [platformRole, ledTeamIds]
  );
  const canManage = isAdmin || (isLead && (ledTeamIds?.size ?? 0) > 0);
  // Deactivating a connection must not make it vanish for the people who can
  // reactivate it — they can opt into seeing inactive rows.
  const [showInactive, setShowInactive] = useState(false);
  const {
    data: repos,
    meta,
    isLoading,
    isError,
    error: loadError,
  } = useRepositories({ includeInactive: canManage && showInactive });
  const suggestions = useRepoDependencySuggestions();
  const scan = useTriggerRepoDependencyScan();
  const [mode, setMode] = useState<ModalMode>(null);

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="connections"
      />
    );
  }

  function handleImportSelect(repo: GitHubRepoInfo) {
    setMode({
      kind: 'create',
      prefill: {
        defaultBranch: repo.defaultBranch,
        description: repo.description ?? undefined,
        // Host overrides only (GHE); github.com repos leave them unset.
        ...hostOverridesFromRepoUrls(repo.htmlUrl, repo.apiUrl),
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
              <label className="flex items-center gap-1.5 text-xs text-paper-400">
                <input
                  checked={showInactive}
                  onChange={(e) => setShowInactive(e.target.checked)}
                  type="checkbox"
                />
                Show inactive
              </label>
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
        title={navLabel('/connections')}
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {(repos ?? []).map((r) => {
          const isGitRepo = !r.type || r.type === 'git_repo';
          return (
            <Card key={r.id}>
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 truncate font-semibold">{connectionLabel(r)}</h3>
                <ConnectionTypeBadge type={r.type ?? 'git_repo'} />
              </div>
              <div className="mt-2 space-y-1 text-sm text-paper-400">
                {isGitRepo && <p>Branch: {r.defaultBranch}</p>}
                <p>Team: {r.team?.name ?? 'None'}</p>
                <p>Workflows: {r._count?.activeWorkflows ?? 0}</p>
                {isGitRepo && <p>Image: {r.executorImage ?? 'default'}</p>}
                {r.description && <p className="truncate text-xs">{r.description}</p>}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span
                  className={`text-xs font-medium ${r.isActive ? 'text-moss-400' : 'text-brick-400'}`}
                >
                  {r.isActive ? 'Active' : 'Inactive'}
                </span>
                <div className="flex items-center gap-1">
                  {isGitRepo && (
                    <Button
                      onClick={() => setMode({ kind: 'dependencies', repo: r })}
                      size="sm"
                      variant="ghost"
                    >
                      Dependencies
                    </Button>
                  )}
                  {canManageTeam(r.team?.id) && (
                    <Button
                      onClick={() => setMode({ kind: 'edit', repo: r })}
                      size="sm"
                      variant="ghost"
                    >
                      Edit
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
        {meta !== undefined && meta.total > (repos ?? []).length && (
          <p className="text-center font-mono text-[11px] uppercase tracking-wider text-paper-500">
            showing the first {(repos ?? []).length} of {meta.total} connections
          </p>
        )}
        {(repos ?? []).length === 0 && (
          <EmptyState
            className="col-span-full py-12"
            hint={
              canManage
                ? 'Use "Import from GitHub" or "Add connection" above.'
                : 'Ask a team lead or admin to add one.'
            }
            title="No connections yet."
          />
        )}
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-sm">Suggested repositories to onboard</h2>
          {isAdmin && (
            <Button
              disabled={scan.isPending}
              onClick={() => scan.mutate()}
              size="sm"
              variant="secondary"
            >
              {scan.isPending ? 'Starting…' : 'Re-scan dependencies'}
            </Button>
          )}
        </div>
        {scan.isError && (
          <p className="text-brick-400 text-xs">
            {errMsg(scan.error, 'Could not start the scan — the schedule may not be registered.')}
          </p>
        )}
        {scan.isSuccess && !scan.isError && (
          // The POST only *starts* the sweep, so the list below is still
          // pre-scan; say so rather than letting it read as "nothing changed".
          <p className="text-paper-500 text-xs">
            Scan started. Suggestions update as it works through the repositories.
          </p>
        )}
        <RepoDependencySuggestions
          error={suggestions.error}
          isError={suggestions.isError}
          isLoading={suggestions.isLoading}
          suggestions={suggestions.data}
        />
      </section>

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

      {mode?.kind === 'dependencies' && (
        <RepoDependenciesModal
          canManage={canManageTeam(mode.repo.team?.id)}
          canManageTeam={canManageTeam}
          onClose={() => setMode(null)}
          open
          repo={mode.repo}
          repos={repos ?? []}
        />
      )}
    </div>
  );
}
