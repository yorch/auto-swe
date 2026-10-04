'use client';

import { getConnectionTypeMetadata, isConnectionType } from '@auto-swe/shared/lib/connectionTypes';
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useCallback, useState } from 'react';
import type { ConnectionPrefill } from '@/components/repositories/ConnectionFormModal';
import { ConnectionFormModal } from '@/components/repositories/ConnectionFormModal';
import { ImportFromGitHubModal } from '@/components/repositories/ImportFromGitHubModal';
import { MyCredentialModal } from '@/components/repositories/MyCredentialModal';
import { RepoDependenciesModal } from '@/components/repositories/RepoDependenciesModal';
import { RepoDependencySuggestions } from '@/components/repositories/RepoDependencySuggestions';
import { ShareRepoModal } from '@/components/repositories/ShareRepoModal';
import { SetupBanner } from '@/components/setup/SetupReadiness';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useHasRole } from '@/hooks/useHasRole';
import {
  useRepoDependencySuggestions,
  useTriggerRepoDependencyScan,
} from '@/hooks/useRepoDependencies';
import type { GitHubRepoInfo } from '@/hooks/useRepositories';
import { useMyCredentials, useRepositories } from '@/hooks/useRepositories';
import { useLedTeamIds } from '@/hooks/useTeams';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';
import { canWriteTeamResource } from '@/lib/teamPermissions';
import { useAuthStore } from '@/stores/authStore';

type ModalMode =
  | { kind: 'create'; prefill?: ConnectionPrefill }
  | { kind: 'edit'; repo: RepositorySummary }
  | { kind: 'dependencies'; repo: RepositorySummary }
  | { kind: 'credential'; repo: RepositorySummary }
  | { kind: 'share'; repo: RepositorySummary }
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
  const myCredentials = useMyCredentials();
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
        // No URL overrides: the import list comes from the instance's own
        // GitHub host, which is what an unset override already means. The
        // repo-level `htmlUrl`/`apiUrl` are not bases — stored as overrides
        // they made every clone and API call land on a path that does not exist.
        language: repo.language ?? undefined,
        organizationName: repo.org,
        repoName: repo.name,
      },
    });
  }

  const formMode = mode?.kind === 'create' || mode?.kind === 'edit' ? mode : null;
  const credentialsEnabled = myCredentials.data?.enabled ?? false;
  const credentialFor = (id: string) =>
    myCredentials.data?.credentials.find((c) => c.connectionId === id);

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          canManage ? (
            <>
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
                Add connection
              </Button>
            </>
          ) : undefined
        }
        chapter="§ Workflows"
        subtitle="External systems — git repos, REST APIs, and other integrations — available to your workflows."
        title="Connections"
      />
      <SetupBanner items={['connections']} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {(repos ?? []).map((r) => {
          const isGitRepo = !r.type || r.type === 'git_repo';
          const myCredential = isGitRepo ? credentialFor(r.id) : undefined;
          // Offered when the feature is on, and kept reachable when it is off
          // but a token is still saved, so it can always be removed.
          const showCredential = isGitRepo && (credentialsEnabled || !!myCredential);
          return (
            <Card key={r.id}>
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 truncate font-semibold">{connectionLabel(r)}</h3>
                <ConnectionTypeBadge type={r.type ?? 'git_repo'} />
              </div>
              <div className="mt-2 space-y-1 text-sm text-paper-400">
                {isGitRepo && <p>Branch: {r.defaultBranch}</p>}
                <p>Team: {r.team?.name ?? 'None'}</p>
                {(r.shares?.length ?? 0) > 0 && (
                  <p className="truncate">
                    Shared with: {(r.shares ?? []).map((s) => s.team.name).join(', ')}
                  </p>
                )}
                <p>Workflows: {r._count?.activeWorkflows ?? 0}</p>
                {isGitRepo && <p>Image: {r.executorImage ?? 'default'}</p>}
                {showCredential && (
                  <p>
                    My token:{' '}
                    {myCredential
                      ? `…${myCredential.lastFour || '????'}${credentialsEnabled ? '' : ' (unused)'}`
                      : 'none — platform credential'}
                  </p>
                )}
                {r.description && <p className="truncate text-xs">{r.description}</p>}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <Badge dot tone={r.isActive ? 'moss' : 'brick'} uppercase>
                  {r.isActive ? 'Active' : 'Inactive'}
                </Badge>
                <div className="flex items-center gap-1">
                  {showCredential && (
                    <Button
                      onClick={() => setMode({ kind: 'credential', repo: r })}
                      size="sm"
                      variant="ghost"
                    >
                      My token
                    </Button>
                  )}
                  {isGitRepo && (
                    <Button
                      onClick={() => setMode({ kind: 'dependencies', repo: r })}
                      size="sm"
                      variant="ghost"
                    >
                      Dependencies
                    </Button>
                  )}
                  {canManageTeam(r.team?.id) && isGitRepo && (
                    // The server decides: only the owning team's leads (and
                    // platform admins) may change sharing.
                    <Button
                      onClick={() => setMode({ kind: 'share', repo: r })}
                      size="sm"
                      variant="ghost"
                    >
                      Share
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
          <p className="col-span-full text-center font-mono text-[11px] uppercase tracking-wider text-paper-500">
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
        <SectionHeader
          actions={
            isAdmin && (
              <Button
                disabled={scan.isPending}
                onClick={() => scan.mutate()}
                size="sm"
                variant="secondary"
              >
                {scan.isPending ? 'Starting…' : 'Re-scan dependencies'}
              </Button>
            )
          }
          title="Suggested repositories to onboard"
        />
        {scan.isError && (
          <Alert>
            {errMsg(scan.error, 'Could not start the scan — the schedule may not be registered.')}
          </Alert>
        )}
        {scan.isSuccess && !scan.isError && (
          // The POST only *starts* the sweep, so the list below is still
          // pre-scan; say so rather than letting it read as "nothing changed".
          <Alert variant="success">
            Scan started. Suggestions update as it works through the repositories.
          </Alert>
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

      {mode?.kind === 'share' && <ShareRepoModal onClose={() => setMode(null)} repo={mode.repo} />}

      {mode?.kind === 'credential' && (
        <MyCredentialModal
          credential={credentialFor(mode.repo.id)}
          enabled={credentialsEnabled}
          hosts={myCredentials.data?.hosts}
          onClose={() => setMode(null)}
          repo={mode.repo}
        />
      )}

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
