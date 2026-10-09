'use client';

import { getConnectionTypeMetadata, isConnectionType } from '@auto-swe/shared/lib/connectionTypes';
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useCallback, useEffect, useState } from 'react';
import { CiTriggersModal } from '@/components/repositories/CiTriggersModal';
import type { ConnectionPrefill } from '@/components/repositories/ConnectionFormModal';
import { ConnectionFormModal } from '@/components/repositories/ConnectionFormModal';
import { ImportFromGitHubModal } from '@/components/repositories/ImportFromGitHubModal';
import { MyCredentialModal } from '@/components/repositories/MyCredentialModal';
import { RepoDependenciesModal } from '@/components/repositories/RepoDependenciesModal';
import { RepoDependencySuggestions } from '@/components/repositories/RepoDependencySuggestions';
import { ShareRepoModal } from '@/components/repositories/ShareRepoModal';
import { SetupBanner } from '@/components/setup/SetupReadiness';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
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
  | { kind: 'ciTriggers'; repo: RepositorySummary }
  | { kind: 'credential'; repo: RepositorySummary }
  | { kind: 'share'; repo: RepositorySummary }
  | { kind: 'import' }
  | null;

function ConnectionTypeBadge({ type }: { type: string }) {
  const label = isConnectionType(type) ? getConnectionTypeMetadata(type).label : type;
  return (
    <Badge tone="neutral" variant="outline">
      {label}
    </Badge>
  );
}

const PAGE_SIZE = 30;

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
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  // Search the server after a pause in typing, so each keystroke is not a request.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const {
    data: repos,
    meta,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useRepositories({
    includeInactive: canManage && showInactive,
    limit: PAGE_SIZE,
    offset,
    q: query || undefined,
  });
  const suggestions = useRepoDependencySuggestions();
  const scan = useTriggerRepoDependencyScan();
  const myCredentials = useMyCredentials();
  const [mode, setMode] = useState<ModalMode>(null);

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

  const rows = repos ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          canManage ? (
            <>
              <Button onClick={() => setMode({ kind: 'import' })} variant="secondary">
                <Icon name="github" size={14} />
                Import from GitHub
              </Button>
              <Button onClick={() => setMode({ kind: 'create' })} variant="primary">
                <Icon name="plus" size={14} />
                Add connection
              </Button>
            </>
          ) : undefined
        }
        subtitle="External systems — git repos, REST APIs, and other integrations — available to your workflows."
        title="Connections"
      />
      <SetupBanner
        here="/connections"
        inPage={
          canManage
            ? { label: 'Add connection', onClick: () => setMode({ kind: 'create' }) }
            : undefined
        }
        items={['connections']}
      />
      <section className="space-y-4">
        <Card className="overflow-hidden p-0">
          <Toolbar
            className="mb-0 border-b border-ink-600 px-4 py-3"
            end={
              meta !== undefined && (
                <span className="tabular text-xs text-paper-500">
                  {meta.total} {meta.total === 1 ? 'connection' : 'connections'}
                </span>
              )
            }
          >
            <SearchInput
              label="Search connections"
              onChange={setSearch}
              placeholder="Search connections…"
              value={search}
            />
            {canManage && (
              <Checkbox
                checked={showInactive}
                className="px-1"
                label="Show inactive"
                onChange={(e) => {
                  setShowInactive(e.target.checked);
                  setOffset(0);
                }}
              />
            )}
          </Toolbar>
          <QueryBoundary
            error={loadError}
            isError={isError}
            isFetching={isFetching}
            isLoading={isLoading}
            label="connections"
            loading={<SkeletonRows className="px-4 py-4" rows={4} />}
            onRetry={() => void refetch()}
          >
            {rows.length === 0 ? (
              <EmptyState
                action={
                  query ? (
                    <Button onClick={() => setSearch('')} size="sm">
                      Clear search
                    </Button>
                  ) : canManage ? (
                    <>
                      <Button onClick={() => setMode({ kind: 'import' })} size="sm">
                        Import from GitHub
                      </Button>
                      <Button
                        onClick={() => setMode({ kind: 'create' })}
                        size="sm"
                        variant="primary"
                      >
                        Add connection
                      </Button>
                    </>
                  ) : undefined
                }
                hint={
                  query
                    ? 'Try a different search.'
                    : canManage
                      ? 'Connect a git repository or an external API so workflows have somewhere to run.'
                      : 'Ask a team lead or admin to add one.'
                }
                icon={query ? 'search' : 'connections'}
                title={query ? 'No connections match your search' : 'No connections yet'}
              />
            ) : (
              <Table stacked>
                <caption className="sr-only">Connections available to your teams</caption>
                <THead>
                  <Th variant="plain">Connection</Th>
                  <Th variant="plain">Type</Th>
                  <Th variant="plain">Team</Th>
                  <Th variant="plain">Branch</Th>
                  <Th align="right" variant="plain">
                    Workflows
                  </Th>
                  <Th variant="plain">Status</Th>
                  <Th align="right" variant="plain">
                    <span className="sr-only">Actions</span>
                  </Th>
                </THead>
                <tbody>
                  {rows.map((r) => {
                    const isGitRepo = !r.type || r.type === 'git_repo';
                    const myCredential = isGitRepo ? credentialFor(r.id) : undefined;
                    // Offered when the feature is on, and kept reachable when it is off
                    // but a token is still saved, so it can always be removed.
                    const showCredential = isGitRepo && (credentialsEnabled || !!myCredential);
                    const canEdit = canManageTeam(r.team?.id);
                    const label = connectionLabel(r);
                    const menu: ActionMenuItem[] = [
                      ...(isGitRepo
                        ? [
                            {
                              icon: 'layers' as const,
                              id: 'dependencies',
                              label: 'Dependencies',
                              onAction: () => setMode({ kind: 'dependencies', repo: r }),
                            },
                            {
                              icon: 'alert' as const,
                              id: 'ciTriggers',
                              label: 'CI-failure triggers',
                              onAction: () => setMode({ kind: 'ciTriggers', repo: r }),
                            },
                          ]
                        : []),
                      ...(showCredential
                        ? [
                            {
                              icon: 'key' as const,
                              id: 'credential',
                              label: myCredential ? 'My token' : 'Use my token',
                              onAction: () => setMode({ kind: 'credential', repo: r }),
                            },
                          ]
                        : []),
                      // The server decides: only the owning team's leads (and
                      // platform admins) may change sharing.
                      ...(canEdit && isGitRepo
                        ? [
                            {
                              icon: 'teams' as const,
                              id: 'share',
                              label: 'Share with teams',
                              onAction: () => setMode({ kind: 'share', repo: r }),
                            },
                          ]
                        : []),
                    ];
                    return (
                      <TRow hover key={r.id}>
                        <Td className="max-w-md px-4 py-3" primary>
                          <div className="truncate font-medium text-paper-100" title={label}>
                            {label}
                          </div>
                          {(r.description || showCredential) && (
                            <div className="mt-0.5 truncate text-xs font-normal text-paper-400">
                              {r.description}
                              {r.description && showCredential && ' · '}
                              {showCredential &&
                                (myCredential
                                  ? `Your token …${myCredential.lastFour || '????'}${credentialsEnabled ? '' : ' (unused)'}`
                                  : 'Platform credential')}
                            </div>
                          )}
                        </Td>
                        <Td className="px-4 py-3" label="Type">
                          <ConnectionTypeBadge type={r.type ?? 'git_repo'} />
                        </Td>
                        <Td className="px-4 py-3 text-paper-300" label="Team">
                          <div>{r.team?.name ?? <span className="text-paper-500">None</span>}</div>
                          {(r.shares?.length ?? 0) > 0 && (
                            <div
                              className="max-w-48 truncate text-xs text-paper-500"
                              title={(r.shares ?? []).map((sh) => sh.team.name).join(', ')}
                            >
                              Shared with {(r.shares ?? []).map((sh) => sh.team.name).join(', ')}
                            </div>
                          )}
                        </Td>
                        <Td className="px-4 py-3" label="Branch">
                          {isGitRepo ? (
                            <>
                              <div className="font-mono text-xs text-paper-300">
                                {r.defaultBranch}
                              </div>
                              {r.executorImage && (
                                <div
                                  className="max-w-48 truncate font-mono text-[11px] text-paper-500"
                                  title={`Executor image: ${r.executorImage}`}
                                >
                                  {r.executorImage}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-paper-500">—</span>
                          )}
                        </Td>
                        <Td
                          align="right"
                          className="tabular px-4 py-3 text-paper-200"
                          label="Workflows"
                        >
                          {r._count?.activeWorkflows ?? 0}
                        </Td>
                        <Td className="px-4 py-3" label="Status">
                          <Badge dot tone={r.isActive ? 'moss' : 'muted'}>
                            {r.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </Td>
                        <Td align="right" className="whitespace-nowrap px-4 py-3">
                          <div className="flex items-center justify-end gap-1 max-sm:justify-start">
                            {canEdit && (
                              <Button
                                aria-label={`Edit ${label}`}
                                onClick={() => setMode({ kind: 'edit', repo: r })}
                                size="sm"
                                variant="ghost"
                              >
                                Edit
                              </Button>
                            )}
                            <ActionMenu items={menu} label={`More actions for ${label}`} />
                          </div>
                        </Td>
                      </TRow>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </QueryBoundary>
        </Card>
        {meta !== undefined && meta.total > PAGE_SIZE && (
          <Pagination
            hasNext={offset + rows.length < meta.total}
            hasPrev={offset > 0}
            onNext={() => setOffset(offset + PAGE_SIZE)}
            onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            rangeEnd={Math.min(offset + PAGE_SIZE, meta.total)}
            rangeStart={offset + 1}
            total={meta.total}
          />
        )}
      </section>

      <section>
        <SectionHeader
          actions={
            isAdmin && (
              <Button
                disabled={scan.isPending}
                onClick={() => scan.mutate()}
                size="sm"
                variant="secondary"
              >
                <Icon name="refresh" size={13} />
                {scan.isPending ? 'Starting…' : 'Re-scan dependencies'}
              </Button>
            )
          }
          hint="Repositories your code depends on that are not connected yet"
          title="Suggested repositories to onboard"
        />
        <div className="space-y-3">
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
        </div>
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

      {mode?.kind === 'ciTriggers' && (
        <CiTriggersModal onClose={() => setMode(null)} repo={mode.repo} />
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
