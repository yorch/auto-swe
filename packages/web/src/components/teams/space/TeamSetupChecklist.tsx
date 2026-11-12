'use client';

import type { TeamSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { Card, CardTitle } from '@/components/ui/Card';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useTeam } from '@/hooks/useTeams';
import { hasRole } from '@/lib/roles';
import { teamHref } from '@/lib/teamSpace';
import { useAuthStore } from '@/stores/authStore';

export function TeamSetupChecklist({ team }: { team: TeamSummary }) {
  const platformRole = useAuthStore((s) => s.user?.role);
  const visible = hasRole(platformRole, 'ADMIN') || hasRole(team.myRole, 'LEAD');
  return visible ? <Checklist team={team} /> : null;
}

function Checklist({ team }: { team: TeamSummary }) {
  const query = useTeam(team.id, { refetchOnMount: 'always' });
  if (!query.data) {
    return (
      <QueryBoundary
        error={query.error}
        isError={query.isError}
        isFetching={query.isFetching}
        isLoading={query.isLoading}
        label="team setup"
        onRetry={() => void query.refetch()}
        shape="detail"
      />
    );
  }
  const detail = query.data;
  const items = [
    {
      done: detail.memberships.length > 1,
      href: teamHref(team.slug, 'members'),
      label: 'Add another team member',
    },
    {
      done:
        detail.repositories.some((r) => r.isActive !== false) ||
        detail.sharedRepositories.length > 0,
      href: `/connections?team=${encodeURIComponent(team.slug)}`,
      label: 'Connect or share a repository',
    },
    {
      done: detail.monthlyBudgetUsdCents != null,
      href: `${teamHref(team.slug, 'settings')}?tab=budget`,
      label: 'Set a team budget',
    },
  ];
  if (items.every((item) => item.done)) {
    return null;
  }
  return (
    <Card>
      <CardTitle>Team setup</CardTitle>
      <p className="mt-2 text-sm text-paper-400">
        Get your team ready for work. A team or organization admin sets the budget.
      </p>
      <ul className="mt-4 space-y-3">
        {items.map((item) => (
          <li className="flex gap-3 text-sm" key={item.label}>
            <span aria-label={item.done ? 'Complete' : 'Incomplete'} role="img">
              {item.done ? '✓' : '○'}
            </span>
            <Link
              className="text-paper-200 underline underline-offset-4 hover:text-paper-50"
              href={item.href}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
