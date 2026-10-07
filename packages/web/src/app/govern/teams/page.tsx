'use client';

import Link from 'next/link';
import { useState } from 'react';
import { TeamFormModal } from '@/components/teams/TeamFormModal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { useHasRole } from '@/hooks/useHasRole';
import { useTeams } from '@/hooks/useTeams';
import { cn, FOCUS_RING, plural } from '@/lib/utils';

/** Above this many teams the page offers a search box. */
const SEARCH_THRESHOLD = 6;

export default function TeamsPage() {
  const { data: teams, isLoading, isError, isFetching, refetch, error: loadError } = useTeams();
  // POST /teams is ADMIN-only.
  const canCreate = useHasRole('ADMIN');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');

  const all = teams ?? [];
  const query = search.trim().toLowerCase();
  const visible = query
    ? all.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.slug.toLowerCase().includes(query) ||
          (t.description ?? '').toLowerCase().includes(query)
      )
    : all;

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
        actions={newTeamButton('md')}
        subtitle="Teams own repositories, members, sandbox allowlists and per-team agent overrides."
        title="Teams"
      />
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
            action={newTeamButton('sm')}
            bordered
            hint={
              canCreate
                ? 'Create a team to group members and repositories.'
                : 'An admin creates teams; ask one to add you.'
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
              <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {visible.map((t) => (
                  <li key={t.id}>
                    <Link
                      className={cn('group block h-full rounded-xl', FOCUS_RING)}
                      href={`/govern/teams/${t.id}`}
                    >
                      <Card className="flex h-full flex-col p-5 group-hover:border-ink-300">
                        <div className="flex items-start gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-400 bg-ink-700 text-paper-400 group-hover:text-ember-300">
                            <Icon name="teams" size={16} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <h2 className="truncate text-base font-semibold text-paper-50">
                              {t.name}
                            </h2>
                            <p className="truncate font-mono text-xs text-paper-500">{t.slug}</p>
                          </div>
                          <Icon
                            className="mt-1 shrink-0 text-paper-600 transition-colors group-hover:text-paper-300"
                            name="chevronRight"
                            size={16}
                          />
                        </div>
                        <p
                          className={cn(
                            'mt-3 line-clamp-2 flex-1 text-[13px] leading-relaxed',
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
            )}
          </>
        )}
      </QueryBoundary>
      <TeamFormModal mode={{ kind: 'create' }} onClose={() => setCreating(false)} open={creating} />
    </div>
  );
}
