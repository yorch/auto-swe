'use client';

import type { TeamSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { CreateTeamDialog } from '@/components/teams/directory/CreateTeamDialog';
import { MyJoinRequestsPanel } from '@/components/teams/directory/MyJoinRequestsPanel';
import { TeamDirectoryView } from '@/components/teams/directory/TeamDirectoryView';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { TabBar } from '@/components/ui/TabBar';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { usePlatformAdmin } from '@/hooks/useCan';
import { useTeamDirectory } from '@/hooks/useJoinRequests';
import { splitTeamsByStanding } from '@/hooks/useTeamNav';
import { useTeams } from '@/hooks/useTeams';
import { navLabel } from '@/lib/navigation';
import { orgRoleLabel, platformRoleLabel, teamRoleLabel } from '@/lib/roleLabels';
import { teamHref } from '@/lib/teamSpace';
import { cn, FOCUS_RING, plural } from '@/lib/utils';

type TeamsView = 'mine' | 'directory' | 'requests';

const VIEWS: { id: TeamsView; label: string }[] = [
  { id: 'mine', label: 'My teams' },
  { id: 'directory', label: 'Directory' },
  { id: 'requests', label: 'My requests' },
];

/** Above this many teams the page offers a search box. */
const SEARCH_THRESHOLD = 3;

export default function TeamsPage() {
  const { data: teams, isLoading, isError, isFetching, refetch, error: loadError } = useTeams();
  // The organizations the server lets this person create a team in: the directory's answer, the
  // same one its own "Create team" button reads, so self-service members see the entry here too.
  const directory = useTeamDirectory({ orgId: '', q: '' });
  const creatableOrgs = directory.data?.pages[0]?.creatableOrgs ?? [];
  const canCreate = creatableOrgs.length > 0;
  const platformAdmin = usePlatformAdmin();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<TeamsView>('mine');

  const all = [...(teams ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const authorityChip = platformAdmin ? platformRoleLabel('ADMIN') : orgRoleLabel('ADMIN');
  const query = search.trim().toLowerCase();
  const visible = query
    ? all.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.slug.toLowerCase().includes(query) ||
          (t.description ?? '').toLowerCase().includes(query)
      )
    : all;

  const { administered, member } = splitTeamsByStanding(visible);

  const newTeamButton = (size: 'sm' | 'md') =>
    canCreate && (
      <Button onClick={() => setCreating(true)} size={size} variant="primary">
        <Icon name="plus" size={14} />
        New team
      </Button>
    );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={view === 'mine' ? newTeamButton('md') : undefined}
        subtitle="Teams own repositories, members, sandbox allowlists and per-team agent overrides."
        title={navLabel('/teams')}
      />
      <TabBar
        active={view}
        ariaLabel="Teams views"
        idPrefix="teams-view"
        onChange={setView}
        tabs={VIEWS}
      />
      {view === 'directory' && <TeamDirectoryView />}
      {view === 'requests' && <MyJoinRequestsPanel />}
      {view === 'mine' && (
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="teams"
          loading={
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {['a', 'b', 'c'].map((k) => (
                <Card key={k}>
                  <Skeleton className="h-5 w-1/2" />
                  <Skeleton className="mt-3 h-4 w-3/4" />
                  <Skeleton className="mt-6 h-4 w-1/3" />
                </Card>
              ))}
            </div>
          }
          onRetry={() => void refetch()}
        >
          {all.length === 0 ? (
            <EmptyState
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {newTeamButton('sm')}
                  <Button onClick={() => setView('directory')} size="sm" variant="secondary">
                    Browse the directory
                  </Button>
                </div>
              }
              bordered
              hint={
                canCreate
                  ? 'Create a team to group members and repositories, or browse the directory to request to join one.'
                  : 'Organization admins and platform admins create teams. Browse the directory to request to join one, or ask an admin to add you.'
              }
              icon="teams"
              title="No teams yet"
            />
          ) : (
            <>
              {all.length > SEARCH_THRESHOLD && (
                <Toolbar
                  end={
                    <span className="text-xs text-paper-500 tabular-nums">
                      {query
                        ? `${visible.length} of ${all.length} teams`
                        : plural(all.length, 'team')}
                    </span>
                  }
                >
                  <SearchInput
                    label="Search teams"
                    onChange={setSearch}
                    placeholder="Search teams…"
                    value={search}
                  />
                </Toolbar>
              )}
              {visible.length === 0 ? (
                <EmptyState
                  action={
                    <Button onClick={() => setSearch('')} size="sm">
                      Clear search
                    </Button>
                  }
                  bordered
                  icon="search"
                  title="No teams match this search"
                />
              ) : (
                <div className="space-y-6">
                  <TeamGroup
                    chip={(t) => teamRoleLabel(t.myRole)}
                    heading={administered.length > 0 ? 'Member' : null}
                    teams={member}
                  />
                  <TeamGroup
                    chip={() => authorityChip}
                    heading="Administered"
                    teams={administered}
                  />
                </div>
              )}
            </>
          )}
        </QueryBoundary>
      )}
      <CreateTeamDialog
        creatableOrgs={creatableOrgs}
        onClose={() => setCreating(false)}
        open={creating}
      />
    </div>
  );
}

/** One group of team cards; nothing at all when it is empty. */
function TeamGroup({
  chip,
  heading,
  teams,
}: {
  chip: (team: TeamSummary) => string;
  heading: string | null;
  teams: TeamSummary[];
}) {
  if (teams.length === 0) {
    return null;
  }
  const id = heading ? `teams-group-${heading.toLowerCase()}` : undefined;
  return (
    <section aria-labelledby={id}>
      {heading && (
        <h2
          className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-paper-500"
          id={id}
        >
          {heading}
        </h2>
      )}
      <ul
        aria-label={heading ?? 'Teams'}
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        {teams.map((t) => (
          <li key={t.id}>
            <Link
              aria-label={t.name}
              className={cn('group block h-full rounded-xl', FOCUS_RING)}
              href={teamHref(t.slug)}
            >
              <Card className="flex h-full flex-col p-5 group-hover:border-ink-300">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-400 bg-ink-700 text-paper-400 group-hover:text-paper-200">
                    <Icon name="teams" size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-base font-semibold text-paper-50">{t.name}</h3>
                    <p className="truncate font-mono text-xs text-paper-500">{t.slug}</p>
                  </div>
                  {chip(t) && (
                    <Badge tone="neutral" variant="outline">
                      {chip(t)}
                    </Badge>
                  )}
                  <Icon
                    className="mt-1 shrink-0 text-paper-600 transition-colors group-hover:text-paper-300"
                    name="chevronRight"
                    size={16}
                  />
                </div>
                <p
                  className={cn(
                    'mt-3 line-clamp-2 flex-1 text-sm leading-relaxed',
                    t.description ? 'text-paper-400' : 'text-paper-500 italic'
                  )}
                >
                  {t.description || 'No description'}
                </p>
                <div className="mt-4 flex gap-4 border-t border-ink-600 pt-3 text-xs text-paper-400">
                  <span className="inline-flex items-center gap-1.5">
                    <Icon className="text-paper-500" name="users" size={13} />
                    {plural(t._count?.memberships ?? 0, 'member')}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Icon className="text-paper-500" name="repositories" size={13} />
                    {plural(t._count?.repositories ?? 0, 'repo')}
                  </span>
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
