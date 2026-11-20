'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/LoadingState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useTeamDirectory } from '@/hooks/useJoinRequests';
import {
  type CreatableOrg,
  type DirectoryTeam,
  directoryAction,
  mergeOrgOptions,
} from '@/lib/joinRequests';
import { teamHref } from '@/lib/teamSpace';
import { plural } from '@/lib/utils';
import { CreateTeamDialog } from './CreateTeamDialog';
import { RequestToJoinDialog } from './RequestToJoinDialog';

/**
 * Every team the viewer may see (the gateway applies `teams.directoryScope`), with a search box,
 * an organization filter and, per row, the viewer's relationship and the action it allows.
 * Creating a team is offered only when the server names organizations to create it in.
 */
export function TeamDirectoryView() {
  const [search, setSearch] = useState('');
  const [orgId, setOrgId] = useState('');
  const q = useDebouncedValue(search.trim(), 300);
  const directory = useTeamDirectory({ orgId, q });
  const [requesting, setRequesting] = useState<DirectoryTeam | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<CreatableOrg[]>([]);

  const pages = directory.data?.pages ?? [];
  const teams = pages.flatMap((p) => p.teams);
  // The first page carries the viewer-level answer; it is the same on every page.
  const creatableOrgs = pages[0]?.creatableOrgs ?? [];
  const scope = pages[0]?.scope;

  const loaded = directory.data;
  useEffect(() => {
    const seen = (loaded?.pages ?? []).flatMap((p) => p.teams);
    setOrgs((known) => {
      const next = mergeOrgOptions(known, seen);
      return next.length === known.length ? known : next;
    });
  }, [loaded]);
  const orgOptions = useMemo(
    () =>
      mergeOrgOptions(
        orgs,
        creatableOrgs.map((o) => ({ orgId: o.id, orgName: o.name }))
      ),
    [orgs, creatableOrgs]
  );
  const filtering = q.length > 0 || orgId !== '';

  return (
    <div className="space-y-4">
      <Toolbar
        end={
          creatableOrgs.length > 0 ? (
            <Button onClick={() => setCreating(true)} size="sm" variant="primary">
              <Icon name="plus" size={14} />
              Create team
            </Button>
          ) : undefined
        }
      >
        <SearchInput
          label="Search the team directory"
          onChange={setSearch}
          placeholder="Search teams…"
          value={search}
        />
        {orgOptions.length > 1 && (
          <Select
            appearance="pill"
            aria-label="Filter by organization"
            onChange={setOrgId}
            options={[
              { label: 'All organizations', value: '' },
              ...orgOptions.map((o) => ({ label: o.name, value: o.id })),
            ]}
            prefix="Organization"
            value={orgId}
          />
        )}
      </Toolbar>
      {scope === 'organization' && (
        <p className="text-xs text-paper-500">Showing teams in the organizations you belong to.</p>
      )}
      {notice && <Alert variant="success">{notice}</Alert>}
      <QueryBoundary
        error={directory.error}
        isError={directory.isError}
        isFetching={directory.isFetching && !directory.isFetchingNextPage}
        isLoading={directory.isLoading}
        label="the team directory"
        loading={
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2" role="status">
            {['a', 'b', 'c', 'd'].map((k) => (
              <li key={k}>
                <Card>
                  <Skeleton className="h-5 w-1/2" />
                  <Skeleton className="mt-3 h-4 w-3/4" />
                </Card>
              </li>
            ))}
          </ul>
        }
        onRetry={() => void directory.refetch()}
      >
        {teams.length === 0 ? (
          <EmptyState
            action={
              filtering ? (
                <Button
                  onClick={() => {
                    setSearch('');
                    setOrgId('');
                  }}
                  size="sm"
                >
                  Clear filters
                </Button>
              ) : undefined
            }
            bordered
            hint={filtering ? undefined : 'No team has been created yet.'}
            icon={filtering ? 'search' : 'teams'}
            title={filtering ? 'No teams match this search' : 'No teams to show'}
          />
        ) : (
          <>
            <ul aria-label="Teams" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {teams.map((t) => (
                <DirectoryRow key={t.id} onRequest={() => setRequesting(t)} team={t} />
              ))}
            </ul>
            {directory.hasNextPage && (
              <div className="flex justify-center">
                <Button
                  disabled={directory.isFetchingNextPage}
                  onClick={() => void directory.fetchNextPage()}
                >
                  {directory.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </QueryBoundary>
      <RequestToJoinDialog
        onClose={() => setRequesting(null)}
        onSent={(t) => setNotice(`Request sent to ${t.name}. You can follow it under My requests.`)}
        open={requesting !== null}
        team={requesting}
      />
      <CreateTeamDialog
        creatableOrgs={creatableOrgs}
        onClose={() => setCreating(false)}
        open={creating}
      />
    </div>
  );
}

function DirectoryRow({ onRequest, team }: { onRequest: () => void; team: DirectoryTeam }) {
  const action = directoryAction(team.relationship);
  return (
    <li>
      <Card className="flex h-full flex-col p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-400 bg-ink-700 text-paper-400">
            <Icon name="teams" size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-paper-50">{team.name}</h3>
            <p className="truncate text-xs text-paper-500">{team.orgName}</p>
          </div>
          {action.badge && (
            <Badge tone={team.relationship === 'MEMBER' ? 'success' : 'warning'} variant="outline">
              {action.badge}
            </Badge>
          )}
        </div>
        <p
          className={`mt-3 line-clamp-2 flex-1 text-sm leading-relaxed ${team.description ? 'text-paper-400' : 'text-paper-500 italic'}`}
        >
          {team.description || 'No description'}
        </p>
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-ink-600 pt-3 text-xs text-paper-400">
          <span className="inline-flex items-center gap-1.5">
            <Icon className="text-paper-500" name="users" size={13} />
            {plural(team.memberCount, 'member')}
          </span>
          {action.canRequest ? (
            <Button
              aria-label={`Request to join ${team.name}`}
              onClick={onRequest}
              size="sm"
              variant="primary"
            >
              Request to join
            </Button>
          ) : team.relationship === 'MEMBER' ? (
            <Link
              aria-label={`Open ${team.name}`}
              className="text-accent-400 hover:underline"
              href={teamHref(team.slug)}
            >
              Open team
            </Link>
          ) : null}
        </div>
      </Card>
    </li>
  );
}
