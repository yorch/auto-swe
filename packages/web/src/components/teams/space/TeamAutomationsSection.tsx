'use client';

import { outcomeLabel, outcomeTone } from '@/components/automations/AutomationHistory';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useAllAutomations } from '@/hooks/useAutomations';
import { useTeam } from '@/hooks/useTeams';

/**
 * The automations a team owns, or that run on a repository it owns: name, trigger, whether it is
 * on and what it last decided. Schedules have their own section. Editing stays on the
 * automations page, narrowed to the team.
 */
export function TeamAutomationsSection({ team }: { team: { id: string; slug: string } }) {
  const all = useAllAutomations();
  const detail = useTeam(team.id);
  const ownedRepoIds = new Set((detail.data?.repositories ?? []).map((r) => r.id));
  const rows = (all.data ?? []).filter(
    (r) =>
      r.kind !== 'schedule' &&
      (r.team?.id === team.id || (!!r.repository && ownedRepoIds.has(r.repository.id)))
  );
  // The repository-owned rows need the team's repository list, so the rows wait for it.
  const failed = all.isError || detail.isError;
  return (
    <Card data-testid="manage-automations">
      <CardHeader className="mb-2">
        <CardTitle>Automations</CardTitle>
        <ButtonLink
          href={`/automations?team=${encodeURIComponent(team.slug)}`}
          size="sm"
          variant="secondary"
        >
          Open
        </ButtonLink>
      </CardHeader>
      <QueryBoundary
        error={all.error ?? detail.error}
        isError={failed}
        isFetching={all.isFetching || detail.isFetching}
        isLoading={all.isLoading || detail.isLoading}
        label="automations"
        onRetry={() => {
          void all.refetch();
          void detail.refetch();
        }}
      >
        {rows.length === 0 ? (
          <EmptyState
            className="py-6"
            hint="An automation starts work when an event on a repository happens."
            icon="clock"
            title="No automations yet"
          />
        ) : (
          <ul className="divide-y divide-ink-600">
            {rows.map((r) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                key={`${r.kind}-${r.id}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-paper-100">{r.name}</span>
                  <span className="block truncate text-xs text-paper-500">{r.when}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {r.lastActivity && (
                    <span className="flex items-center gap-1.5 text-xs text-paper-500">
                      <Badge tone={outcomeTone(r.lastActivity.outcome)} variant="outline">
                        {outcomeLabel(r.lastActivity.outcome)}
                      </Badge>
                      <RelativeTime value={r.lastActivity.at} />
                    </span>
                  )}
                  <Badge dot tone={r.enabled ? 'success' : 'muted'} variant="text">
                    {r.enabled ? 'Enabled' : 'Paused'}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Card>
  );
}
