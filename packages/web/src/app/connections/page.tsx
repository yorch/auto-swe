'use client';

import { getConnectionTypeMetadata, isConnectionType } from '@auto-swe/shared/lib/connectionTypes';
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useCallback, useEffect, useState } from 'react';
import { ProbeModal } from '@/components/integrations/ProbeModal';
import { KnowledgeBaseLinksSection } from '@/components/knowledgeBases/KnowledgeBaseLinksSection';
import type { ConnectionPrefill } from '@/components/repositories/ConnectionFormModal';
import { ConnectionFormModal } from '@/components/repositories/ConnectionFormModal';
import { ImportFromGitHubModal } from '@/components/repositories/ImportFromGitHubModal';
import { MyCredentialModal } from '@/components/repositories/MyCredentialModal';
import { OnboardingPrModal } from '@/components/repositories/OnboardingPrModal';
import { RepoAutomationsModal } from '@/components/repositories/RepoAutomationsModal';
import { RepoDependenciesModal } from '@/components/repositories/RepoDependenciesModal';
import { RepoDependencySuggestions } from '@/components/repositories/RepoDependencySuggestions';
import { RepoOnboardingChecklist } from '@/components/repositories/RepoOnboardingChecklist';
import { OnboardingRunLink } from '@/components/repositories/RunOnboardingButton';
import { ShareRepoModal } from '@/components/repositories/ShareRepoModal';
import { ToggleConnectionActiveModal } from '@/components/repositories/ToggleConnectionActiveModal';
import { SetupBanner } from '@/components/setup/SetupReadiness';
import { GuardedButton } from '@/components/teams/GuardedButton';
import { OwnerChip } from '@/components/teams/OwnerChip';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable } from '@/components/ui/DataTable';
import { DocLink } from '@/components/ui/DocLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { useHasRole } from '@/hooks/useHasRole';
import {
  useRepoDependencySuggestions,
  useTriggerRepoDependencyScan,
} from '@/hooks/useRepoDependencies';
import { useMyCredentials, useRepositories, useRunRepoOnboarding } from '@/hooks/useRepositories';
import { useRepositoryTeams } from '@/hooks/useRepositoryTeams';
import { useAdminTeamIds, useTeams } from '@/hooks/useTeams';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';
import { HELP_LINKS } from '@/lib/helpLinks';
import { canAuthorTeamCode, repoLeadReason, repoManageReason } from '@/lib/teamPermissions';
import { useAuthStore } from '@/stores/authStore';

type ModalMode =
  | { kind: 'create'; prefill?: ConnectionPrefill }
  | { kind: 'edit'; repo: RepositorySummary }
  | { kind: 'dependencies'; repo: RepositorySummary }
  | { kind: 'knowledge-bases'; repo: RepositorySummary }
  | { kind: 'automations'; repo: RepositorySummary }
  | { kind: 'credential'; repo: RepositorySummary }
  | { kind: 'share'; repo: RepositorySummary }
  | { kind: 'test'; repo: RepositorySummary }
  | { kind: 'onboarding-pr'; repo: RepositorySummary }
  | { kind: 'test-pagerduty'; repo: RepositorySummary }
  | { kind: 'test-pagerduty-events'; repo: RepositorySummary }
  | { kind: 'toggle'; repo: RepositorySummary }
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
  const onboarding = useRunRepoOnboarding();
  const adminTeamIds = useAdminTeamIds();
  const platformRole = useAuthStore((s) => s.user?.role);
  const isAdmin = useHasRole('ADMIN');
  const managedTeams = useRepositoryTeams();
  const canManageTeam = useCallback(
    (teamId: string | null | undefined) => isAdmin || managedTeams.some((t) => t.id === teamId),
    [isAdmin, managedTeams]
  );
  // The owner chip names a team the viewer is looking at from outside; their own team's repository
  // is not "owned by" someone else.
  const myTeamIds = new Set((useTeams({ memberOnly: true }).data ?? []).map((t) => t.id));
  const canManage = isAdmin || managedTeams.length > 0;
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
  // A saved change (deactivated, token saved) closes its dialog, so say it here.
  const [notice, setNotice] = useState<string | null>(null);

  const formMode = mode?.kind === 'create' || mode?.kind === 'edit' ? mode : null;
  const credentialsEnabled = myCredentials.data?.enabled ?? false;
  const credentialFor = (id: string) =>
    myCredentials.data?.credentials.find((c) => c.connectionId === id);
  // Offered when the feature is on, and kept reachable when it is off but a token is still
  // saved, so it can always be removed.
  const showsCredential = (r: { id: string; type?: string | null }) =>
    (!r.type || r.type === 'git_repo') && (credentialsEnabled || !!credentialFor(r.id));

  const rows = repos ?? [];

  return (
    <div className="space-y-8">
      {onboarding.isError && (
        <Alert variant="error">{errMsg(onboarding.error, 'Could not start onboarding')}</Alert>
      )}
      {onboarding.data && (
        <Alert variant="info">
          <OnboardingRunLink run={onboarding.data} />
        </Alert>
      )}
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
        help={
          <p>
            A connection <HelpTip term="connection" /> is a configured link to an outside system: a
            source repository, an issue tracker, a REST API, an MCP server, Notion, Slack and so on.
            Workflows use connections to read and change things.
            {isAdmin && (
              <>
                {' '}
                For a repository, see{' '}
                <DocLink label="GitHub App setup" {...HELP_LINKS.githubAppSetup} />.
              </>
            )}
          </p>
        }
        subtitle="Configured links to outside systems that workflows read and change."
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
      {notice && (
        <Alert
          action={
            <Button onClick={() => setNotice(null)} size="sm" variant="ghost">
              Dismiss
            </Button>
          }
          variant="success"
        >
          {notice}
        </Alert>
      )}
      <section className="space-y-4">
        <Card className="overflow-hidden p-0">
          <Toolbar
            className="mb-0 border-b border-ink-600 px-4 py-3"
            end={
              meta !== undefined && (
                <span className="tabular text-xs text-paper-500">
                  {meta.total} {meta.total === 1 ? 'connection' : 'connections'}
                  {canManage && showInactive ? ' (including inactive)' : ''}
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
            loading={<SkeletonRows className="px-4 py-4" label="connections" rows={4} />}
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
                      : 'Ask a lead of the owning team or an administrator to add one. They will need the repository’s organization and name (or the system’s URL) and the credentials it needs. For a repository, the platform needs a GitHub App installation or token with push access.'
                }
                icon={query ? 'search' : 'connections'}
                title={query ? 'No connections match your search' : 'No connections yet'}
              />
            ) : (
              <DataTable
                actions={(r) => {
                  const manageReason = (repo: typeof r) =>
                    canManageTeam(repo.team?.id) ? null : repoLeadReason(repo.team?.name);
                  const isGitRepo = !r.type || r.type === 'git_repo';
                  const label = connectionLabel(r);
                  const menu: ActionMenuItem[] = [
                    ...(isGitRepo &&
                    r.isActive &&
                    canAuthorTeamCode(platformRole, r.team?.id, adminTeamIds)
                      ? [
                          {
                            disabledReason: onboarding.isPending ? 'Starting onboarding' : null,
                            icon: 'workflows' as const,
                            id: 'onboarding',
                            label: 'Run onboarding',
                            onAction: () => onboarding.mutate(r.id),
                          },
                        ]
                      : []),
                    ...(isGitRepo
                      ? [
                          {
                            disabledReason: canManageTeam(r.team?.id)
                              ? null
                              : repoManageReason(r.team?.name, 'open an onboarding PR for'),
                            icon: 'pullRequest' as const,
                            id: 'onboarding-pr',
                            label: 'Open onboarding PR',
                            onAction: () => setMode({ kind: 'onboarding-pr', repo: r }),
                          },
                          {
                            icon: 'layers' as const,
                            id: 'dependencies',
                            label: 'Dependencies',
                            onAction: () => setMode({ kind: 'dependencies', repo: r }),
                          },
                          {
                            icon: 'layers' as const,
                            id: 'knowledge-bases',
                            label: 'Knowledge bases',
                            onAction: () => setMode({ kind: 'knowledge-bases', repo: r }),
                          },
                          {
                            icon: 'workflows' as const,
                            id: 'automations',
                            label: 'Automations',
                            onAction: () => setMode({ kind: 'automations', repo: r }),
                          },
                        ]
                      : []),
                    ...(showsCredential(r)
                      ? [
                          {
                            icon: 'key' as const,
                            id: 'credential',
                            label: credentialFor(r.id) ? 'My token' : 'Use my token',
                            onAction: () => setMode({ kind: 'credential', repo: r }),
                          },
                        ]
                      : []),
                    // The server decides: only the owning team's leads (and platform admins)
                    // may change sharing or switch a connection off. Others see the entries
                    // disabled, with who can.
                    ...(isGitRepo
                      ? [
                          {
                            disabledReason: manageReason(r),
                            icon: 'teams' as const,
                            id: 'share',
                            label: 'Share with teams',
                            onAction: () => setMode({ kind: 'share', repo: r }),
                          },
                        ]
                      : []),
                    {
                      disabledReason: manageReason(r),
                      icon: (r.isActive ? 'pause' : 'play') as 'pause' | 'play',
                      id: 'toggle-active',
                      label: r.isActive ? 'Deactivate' : 'Reactivate',
                      onAction: () => setMode({ kind: 'toggle', repo: r }),
                      tone: r.isActive ? ('danger' as const) : ('default' as const),
                    },
                  ];
                  return (
                    <>
                      {isGitRepo && (
                        // The server decides, as it does for sharing: only the owning team's
                        // leads (and platform admins) may check what the platform's credential
                        // can do with the repository.
                        <GuardedButton
                          aria-label={`Test access for ${label}`}
                          blockedReason={
                            canManageTeam(r.team?.id)
                              ? null
                              : repoManageReason(r.team?.name, 'test access for')
                          }
                          onClick={() => setMode({ kind: 'test', repo: r })}
                          size="sm"
                          variant="ghost"
                        >
                          Test access
                        </GuardedButton>
                      )}
                      {r.type === 'pagerduty' && (
                        <GuardedButton
                          aria-label={`Test connection ${label}`}
                          blockedReason={
                            canManageTeam(r.team?.id)
                              ? null
                              : repoManageReason(r.team?.name, 'test')
                          }
                          onClick={() => setMode({ kind: 'test-pagerduty', repo: r })}
                          size="sm"
                          variant="ghost"
                        >
                          Test connection
                        </GuardedButton>
                      )}
                      {r.type === 'pagerduty_events' && (
                        <GuardedButton
                          aria-label={`Test connection ${label}`}
                          blockedReason={
                            canManageTeam(r.team?.id)
                              ? null
                              : repoManageReason(r.team?.name, 'test')
                          }
                          onClick={() => setMode({ kind: 'test-pagerduty-events', repo: r })}
                          size="sm"
                          variant="ghost"
                        >
                          Test connection
                        </GuardedButton>
                      )}
                      <GuardedButton
                        aria-label={`Edit ${label}`}
                        blockedReason={
                          canManageTeam(r.team?.id) ? null : repoManageReason(r.team?.name, 'edit')
                        }
                        onClick={() => setMode({ kind: 'edit', repo: r })}
                        size="sm"
                        variant="ghost"
                      >
                        Edit
                      </GuardedButton>
                      <ActionMenu items={menu} label={`More actions for ${label}`} />
                    </>
                  );
                }}
                caption="Connections available to your teams"
                columns={[
                  {
                    cell: (r) => <span>{connectionLabel(r)}</span>,
                    header: 'Connection',
                    id: 'connection',
                    primary: true,
                    secondary: (r) => {
                      const myCredential = credentialFor(r.id);
                      const showCredential = showsCredential(r);
                      const image = !r.type || r.type === 'git_repo' ? r.executorImage : null;
                      return (
                        <>
                          {(r.description || showCredential || image) && (
                            <span className="block truncate">
                              {r.description}
                              {r.description && (showCredential || image) && ' · '}
                              {image && `Image ${image}`}
                              {image && showCredential && ' · '}
                              {showCredential &&
                                (myCredential
                                  ? `Your token …${myCredential.lastFour || '????'}${credentialsEnabled ? '' : ' (unused)'}`
                                  : 'Platform credential')}
                            </span>
                          )}
                          <RepoOnboardingChecklist
                            canManage={canManageTeam(r.team?.id)}
                            onOnboardingPr={() => setMode({ kind: 'onboarding-pr', repo: r })}
                            onSetup={() => setMode({ kind: 'edit', repo: r })}
                            onStack={() => setMode({ kind: 'edit', repo: r })}
                            onTestAccess={() => setMode({ kind: 'test', repo: r })}
                            repo={r}
                          />
                        </>
                      );
                    },
                    width: 'sm:max-w-md',
                  },
                  {
                    cell: (r) => <ConnectionTypeBadge type={r.type ?? 'git_repo'} />,
                    header: 'Type',
                    id: 'type',
                  },
                  {
                    cell: (r) => (
                      <div className="text-paper-300">
                        <div>{r.team?.name ?? <span className="text-paper-500">None</span>}</div>
                        {!canManageTeam(r.team?.id) && r.team?.name && (
                          <div className="mt-1 text-xs text-paper-500">
                            {!myTeamIds.has(r.team.id) && (
                              <>
                                <OwnerChip ownerName={r.team.name} />{' '}
                              </>
                            )}
                            Read-only for you
                          </div>
                        )}
                        {(r.shares?.length ?? 0) > 0 && (
                          <div
                            className="max-w-48 truncate text-xs text-paper-500"
                            title={(r.shares ?? []).map((sh) => sh.team.name).join(', ')}
                          >
                            Shared with {(r.shares ?? []).map((sh) => sh.team.name).join(', ')}
                          </div>
                        )}
                      </div>
                    ),
                    header: 'Team',
                    id: 'team',
                  },
                  {
                    cell: (r) =>
                      !r.type || r.type === 'git_repo' ? (
                        <span className="font-mono text-xs text-paper-300">{r.defaultBranch}</span>
                      ) : (
                        <span className="text-paper-500">
                          <span aria-hidden>—</span>
                          <span className="sr-only">Not applicable</span>
                        </span>
                      ),
                    header: 'Branch',
                    id: 'branch',
                  },
                  {
                    align: 'right',
                    cell: (r) => (
                      <span className="tabular text-paper-200">
                        {r._count?.activeWorkflows ?? 0}
                      </span>
                    ),
                    header: 'Active workflows',
                    id: 'workflows',
                  },
                  {
                    cell: (r) => (
                      <Badge dot tone={r.isActive ? 'success' : 'muted'}>
                        {r.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    ),
                    header: 'Status',
                    id: 'status',
                  },
                ]}
                getRowId={(r) => r.id}
                revealActions={false}
                rows={rows}
              />
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
            <Alert
              action={
                <Button onClick={() => scan.reset()} size="sm" variant="ghost">
                  Dismiss
                </Button>
              }
              variant="success"
            >
              Scan started. Suggestions update as it works through the repositories.
            </Alert>
          )}
          <RepoDependencySuggestions
            emptyText={
              isAdmin
                ? undefined
                : 'No suggestions yet. An administrator can re-scan dependencies to look for repositories to onboard.'
            }
            error={suggestions.error}
            isError={suggestions.isError}
            isLoading={suggestions.isLoading}
            onOnboard={canManage ? (prefill) => setMode({ kind: 'create', prefill }) : undefined}
            suggestions={suggestions.data}
          />
        </div>
      </section>

      {mode?.kind === 'import' && <ImportFromGitHubModal onClose={() => setMode(null)} open />}

      {formMode && <ConnectionFormModal mode={formMode} onClose={() => setMode(null)} open />}

      {mode?.kind === 'toggle' && (
        <ToggleConnectionActiveModal
          onClose={() => setMode(null)}
          onDone={setNotice}
          repo={mode.repo}
        />
      )}

      {mode?.kind === 'share' && <ShareRepoModal onClose={() => setMode(null)} repo={mode.repo} />}

      {mode?.kind === 'test' && (
        <ProbeModal
          onClose={() => {
            setMode(null);
            refetch();
          }}
          path={`/api/v1/repositories/${mode.repo.id}/test-access`}
          subtitle={connectionLabel(mode.repo)}
          title="Test repository access"
        />
      )}

      {mode?.kind === 'onboarding-pr' && (
        <OnboardingPrModal onClose={() => setMode(null)} repo={mode.repo} />
      )}

      {mode?.kind === 'test-pagerduty' && (
        <ProbeModal
          onClose={() => setMode(null)}
          path={`/api/v1/repositories/${mode.repo.id}/test-pagerduty`}
          subtitle={connectionLabel(mode.repo)}
          title="Test PagerDuty connection"
        />
      )}

      {mode?.kind === 'test-pagerduty-events' && (
        <ProbeModal
          onClose={() => setMode(null)}
          path={`/api/v1/repositories/${mode.repo.id}/test-pagerduty-events`}
          subtitle={connectionLabel(mode.repo)}
          title="Test PagerDuty change events"
        />
      )}

      {mode?.kind === 'credential' && (
        <MyCredentialModal
          credential={credentialFor(mode.repo.id)}
          enabled={credentialsEnabled}
          hosts={myCredentials.data?.hosts}
          onClose={() => setMode(null)}
          onSaved={setNotice}
          repo={mode.repo}
        />
      )}

      {mode?.kind === 'automations' && (
        <RepoAutomationsModal onClose={() => setMode(null)} repo={mode.repo} />
      )}

      {mode?.kind === 'knowledge-bases' && (
        <Modal
          onClose={() => setMode(null)}
          open
          size="lg"
          title={`Knowledge bases · ${connectionLabel(mode.repo)}`}
        >
          <KnowledgeBaseLinksSection
            canManage={canManageTeam(mode.repo.team.id)}
            target={{ repoId: mode.repo.id, scope: 'REPO' }}
            teamId={mode.repo.team.id}
          />
        </Modal>
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
