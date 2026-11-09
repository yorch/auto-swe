'use client';

import type { TeamOverview, TeamOverviewActivityItem } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Stat } from '@/components/ui/Stat';
import { requestHref } from '@/lib/requestDisplay';
import { cn, FOCUS_RING } from '@/lib/utils';

const STATE: Record<TeamOverviewActivityItem['state'], { label: string; tone: BadgeTone }> = {
  active: { label: 'Running', tone: 'info' },
  attention: { label: 'Needs attention', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  success: { label: 'Succeeded', tone: 'success' },
};

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–';
}

function dollars(cents: number): string {
  return new Intl.NumberFormat('en-US', { currency: 'USD', style: 'currency' }).format(cents / 100);
}

function activityHref(item: TeamOverviewActivityItem): string | null {
  if (item.requestId) {
    return requestHref(item.requestId);
  }
  return item.runId ? `/runs/${encodeURIComponent(item.runId)}` : null;
}

function ActivityRow({ item }: { item: TeamOverviewActivityItem }) {
  const state = STATE[item.state];
  const href = activityHref(item);
  const title = href ? (
    <Link
      className={cn('truncate font-medium text-paper-100 hover:underline', FOCUS_RING)}
      href={href}
    >
      {item.title}
    </Link>
  ) : (
    <span className="truncate font-medium text-paper-100">{item.title}</span>
  );
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
      <Badge tone={state.tone} variant="outline">
        {state.label}
      </Badge>
      <span className="flex min-w-0 flex-1 basis-48">{title}</span>
      <span className="flex items-center gap-2 text-xs text-paper-500">
        {item.repoName && <span className="font-mono">{item.repoName}</span>}
        {item.launchedByName && <span>by {item.launchedByName}</span>}
        <RelativeTime value={item.occurredAt} />
      </span>
    </li>
  );
}

/**
 * A team's overview. The sections that depend on the caller's team role render only when the
 * server sent them (`lead`, `admin`): the platform role never decides what is shown here.
 */
export function TeamOverviewView({ overview, slug }: { overview: TeamOverview; slug: string }) {
  const { last7d, pullRequests: pr } = overview;
  const q = `?team=${encodeURIComponent(slug)}`;
  return (
    <div className="space-y-6">
      <section aria-label="Team numbers" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          hint={
            <Link
              className="underline-offset-2 hover:underline"
              href={`/approvals${q}&actionable=1`}
            >
              Open your steps
            </Link>
          }
          label="Needs you"
          tone={overview.needsYou.total > 0 ? 'warning' : 'default'}
          value={overview.needsYou.total}
          variant="tile"
        />
        <Stat
          hint={`${overview.queued} queued`}
          label="Running"
          value={overview.running}
          variant="tile"
        />
        <Stat
          hint={`${last7d.succeeded} of ${last7d.started} started succeeded, ${last7d.failed} failed`}
          label="7-day success"
          value={percent(last7d.succeeded, last7d.started)}
          variant="tile"
        />
        <Stat
          hint={`${pr.opened} opened, ${pr.closedUnmerged} closed unmerged · 30 days${
            pr.timeToMergeP50Hours === null
              ? ''
              : ` · median ${Math.round(pr.timeToMergeP50Hours)} h to merge`
          }`}
          label="PRs merged"
          value={pr.merged}
          variant="tile"
        />
      </section>

      {overview.lead && (
        <Card data-testid="lead-panel">
          <CardHeader className="mb-3">
            <CardTitle>Team attention</CardTitle>
          </CardHeader>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-paper-400">Failures with no owner</dt>
              <dd className="tabular text-2xl font-semibold text-paper-50">
                {overview.lead.unownedFailures}
              </dd>
              <dd className="text-xs text-paper-500">
                Failed runs whose launcher has left the team.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-paper-400">Stale approvals</dt>
              <dd className="tabular text-2xl font-semibold text-paper-50">
                {overview.lead.staleApprovals}
              </dd>
              <dd className="text-xs text-paper-500">Pending past their deadline.</dd>
            </div>
            <div>
              <dt className="text-sm text-paper-400">Open pull requests</dt>
              <dd className="tabular text-2xl font-semibold text-paper-50">
                <Link
                  className="underline-offset-2 hover:underline"
                  href={`/pull-requests${q}&scope=TEAM`}
                >
                  {overview.lead.openPullRequests}
                </Link>
              </dd>
              <dd className="text-xs text-paper-500">Waiting for a human to merge.</dd>
            </div>
          </dl>
        </Card>
      )}

      {overview.admin && (
        <Card data-testid="admin-panel">
          <CardHeader className="mb-2">
            <CardTitle>Spend this month</CardTitle>
          </CardHeader>
          <p className="tabular text-2xl font-semibold text-paper-50">
            {overview.admin.monthCostUsdCents === null
              ? 'Not available'
              : dollars(overview.admin.monthCostUsdCents)}
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="p-0">
          <CardHeader className="mb-0 px-4 pt-4 pb-2">
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          {overview.activity.length === 0 ? (
            <EmptyState
              className="py-8"
              hint="Requests on this team's repositories appear here."
              icon="inbox"
              title="No recent activity"
            />
          ) : (
            <ul className="divide-y divide-ink-600">
              {overview.activity.map((item) => (
                <ActivityRow
                  item={item}
                  key={`${item.requestId ?? item.runId}-${item.occurredAt}`}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader className="mb-2">
            <CardTitle>Repositories</CardTitle>
            <span className="tabular text-xs text-paper-500">{overview.repos.length}</span>
          </CardHeader>
          {overview.repos.length === 0 ? (
            <EmptyState
              className="py-6"
              hint="Add one from Connections, or ask for one to be shared."
              icon="repositories"
              title="No repositories yet"
            />
          ) : (
            <ul className="divide-y divide-ink-600">
              {overview.repos.map((repo) => (
                <li className="flex items-center justify-between gap-3 py-2.5" key={repo.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="shrink-0 text-paper-500" name="repositories" size={14} />
                    <span className="truncate font-mono text-sm text-paper-200" title={repo.name}>
                      {repo.name}
                    </span>
                  </span>
                  <Badge tone={repo.relation === 'owned' ? 'neutral' : 'info'} variant="outline">
                    {repo.relation === 'owned'
                      ? 'owned'
                      : `shared from ${repo.ownerTeamName ?? 'another team'}`}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
