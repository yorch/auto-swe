'use client';

import type { ScheduledWorkRequestSummary } from '@auto-swe/shared/types/api';
import { outcomeLabel, outcomeTone } from '@/components/automations/AutomationHistory';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useSchedules } from '@/hooks/useSchedules';

/** On unless paused, deactivated, or its Temporal schedule is gone; unknown reads as the flag. */
function isEnabled(s: ScheduledWorkRequestSummary): boolean {
  return s.isActive && !s.schedule.paused && s.schedule.exists !== false;
}

/**
 * The schedules a team owns: name, cadence, whether it is on and what its latest fire decided.
 * The list is read-only; the editor opens on the schedules page, which is not narrowed to the team.
 */
export function TeamSchedulesSection({ team }: { team: { id: string; slug: string } }) {
  const { data, error, isError, isFetching, isLoading, refetch } = useSchedules({
    teamId: team.id,
  });
  return (
    <Card data-testid="manage-schedules">
      <CardHeader className="mb-2">
        <CardTitle>Schedules</CardTitle>
        <ButtonLink href="/admin/schedules" size="sm" variant="secondary">
          Open schedules
        </ButtonLink>
      </CardHeader>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="schedules"
        onRetry={() => void refetch()}
      >
        {(data ?? []).length === 0 ? (
          <EmptyState
            className="py-6"
            hint="A schedule starts work on a repository on a cron cadence."
            icon="clock"
            title="No schedules yet"
          />
        ) : (
          <ul className="divide-y divide-ink-600">
            {(data ?? []).map((s) => (
              <li className="flex flex-wrap items-center justify-between gap-3 py-2.5" key={s.id}>
                <span className="min-w-0">
                  <span className="block truncate text-sm text-paper-100">{s.name}</span>
                  <span className="block font-mono text-xs text-paper-500">{s.cronExpression}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {s.lastDecision && (
                    <span className="flex items-center gap-1.5 text-xs text-paper-500">
                      <Badge tone={outcomeTone(s.lastDecision.outcome)} variant="outline">
                        {outcomeLabel(s.lastDecision.outcome)}
                      </Badge>
                      <RelativeTime value={s.lastDecision.at} />
                    </span>
                  )}
                  <Badge dot tone={isEnabled(s) ? 'success' : 'muted'} variant="text">
                    {isEnabled(s) ? 'Enabled' : 'Paused'}
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
