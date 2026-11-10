'use client';

import { usePathname } from 'next/navigation';
import { type ReactNode, use, useEffect, useRef } from 'react';
import NotFound from '@/app/not-found';
import { TeamSpaceProvider } from '@/components/teams/space/TeamSpaceContext';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { TabBar } from '@/components/ui/TabBar';
import { useUserOrgs } from '@/hooks/useAdmin';
import { useTeams } from '@/hooks/useTeams';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { hasRole } from '@/lib/roles';
import { validateRouteParam } from '@/lib/routeParams';
import { canManageTeamBudget } from '@/lib/teamPermissions';
import {
  TEAM_ROLE_LABEL,
  TEAM_TABS,
  type TeamTabId,
  teamHref,
  teamSettingsScope,
  teamTabFromPath,
} from '@/lib/teamSpace';
import { useAuthStore } from '@/stores/authStore';

/**
 * One team's space. The slug in the address is the scope: it resolves through the caller's own
 * teams, and a slug that names no team they belong to renders the ordinary not-found page, which
 * says nothing about whether such a team exists. A platform ADMIN may also open a team they are
 * not in (they can already list every team), without a role badge.
 */
export default function TeamSpaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug: rawSlug } = use(params);
  const slug = validateRouteParam(rawSlug);
  const pathname = usePathname();
  const platformRole = useAuthStore((s) => s.user?.role);
  const isPlatformAdmin = hasRole(platformRole, 'ADMIN');
  const memberTeams = useTeams({ memberOnly: true });
  const allTeams = useTeams({ enabled: isPlatformAdmin });
  const { loaded, lastTeamSlug, setLastTeamSlug } = useUserPreferences();
  // An ORG_ADMIN of the team's organization may open Settings for its Budget section; the lookup
  // is skipped for callers who already hold the budget some other way.
  const holdsBudget =
    isPlatformAdmin || hasRole(memberTeams.data?.find((t) => t.slug === slug)?.myRole, 'ADMIN');
  const userOrgs = useUserOrgs({ enabled: !holdsBudget });

  const team =
    (slug ? memberTeams.data?.find((t) => t.slug === slug) : undefined) ??
    (isPlatformAdmin && slug ? allTeams.data?.find((t) => t.slug === slug) : undefined);

  // Remember the visit as the user's last team. Written once per slug: a failed write must not
  // be retried on every render.
  const written = useRef<string | null>(null);
  const memberSlug = team?.myRole ? team.slug : null;
  useEffect(() => {
    if (memberSlug && loaded && lastTeamSlug !== memberSlug && written.current !== memberSlug) {
      written.current = memberSlug;
      setLastTeamSlug(memberSlug);
    }
  }, [memberSlug, loaded, lastTeamSlug, setLastTeamSlug]);

  if (!slug) {
    return <NotFound />;
  }
  if (!team) {
    const waiting = memberTeams.isLoading || (isPlatformAdmin && allTeams.isLoading);
    if (waiting || memberTeams.isError) {
      return (
        <QueryBoundary
          error={memberTeams.error}
          isError={memberTeams.isError}
          isFetching={memberTeams.isFetching}
          isLoading={waiting}
          label="team"
          onRetry={() => void memberTeams.refetch()}
          shape="detail"
        />
      );
    }
    return <NotFound />;
  }

  const isOrgAdmin = (userOrgs.data ?? []).some(
    (o) => o.id === team.orgId && o.role === 'ORG_ADMIN'
  );
  const canSeeSettings = teamSettingsScope(platformRole, team.myRole, isOrgAdmin) !== null;
  const canManageBudget = canManageTeamBudget(platformRole, team.myRole, isOrgAdmin);
  const tabs = TEAM_TABS.filter((tab) => tab.id !== 'settings' || canSeeSettings).map((tab) => ({
    href: teamHref(team.slug, tab.id),
    id: tab.id,
    label: tab.label,
  }));
  const active: TeamTabId = teamTabFromPath(pathname) ?? 'overview';

  return (
    <TeamSpaceProvider value={{ canManageBudget, canSeeSettings, team }}>
      <div className="space-y-6">
        <PageHeader
          className="mb-0"
          subtitle={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{team.orgName}</span>
              {team.myRole && (
                <Badge tone="neutral" variant="outline">
                  you: {TEAM_ROLE_LABEL[team.myRole]}
                </Badge>
              )}
            </span>
          }
          title={team.name}
        />
        <TabBar active={active} ariaLabel="Team sections" tabs={tabs} />
        {children}
      </div>
    </TeamSpaceProvider>
  );
}
