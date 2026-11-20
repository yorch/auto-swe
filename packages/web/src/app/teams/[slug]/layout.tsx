'use client';

import { usePathname } from 'next/navigation';
import { type ReactNode, use, useEffect, useRef } from 'react';
import NotFound from '@/app/not-found';
import { TeamSpaceProvider } from '@/components/teams/space/TeamSpaceContext';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { TabBar } from '@/components/ui/TabBar';
import { useCan, usePlatformAdmin } from '@/hooks/useCan';
import { useEffectivePermissions } from '@/hooks/useEffectivePermissions';
import { useEntityTitle } from '@/hooks/useEntityTitle';
import { useTeamOverview } from '@/hooks/useTeamOverview';
import { useTeams } from '@/hooks/useTeams';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { teamRoleLabel } from '@/lib/roleLabels';
import { validateRouteParam } from '@/lib/routeParams';
import { TEAM_TABS, type TeamTabId, teamHref, teamTabFromPath } from '@/lib/teamSpace';

/**
 * One team's space. The slug in the address is the scope: it resolves through the caller's own
 * teams, and a slug that names no team they belong to renders the ordinary not-found page, which
 * says nothing about whether such a team exists. A platform admin may also open a team they are
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
  const isPlatformAdmin = usePlatformAdmin();
  const permissions = useEffectivePermissions();
  const memberTeams = useTeams({ memberOnly: true });
  const allTeams = useTeams({ enabled: isPlatformAdmin });
  const { loaded, lastTeamSlug, setLastTeamSlug } = useUserPreferences();

  const team =
    (slug ? memberTeams.data?.find((t) => t.slug === slug) : undefined) ??
    (isPlatformAdmin && slug ? allTeams.data?.find((t) => t.slug === slug) : undefined);
  // What the tabs offer is what the server says the caller holds on this team: Settings for the
  // team's configuration, Manage for what its leads run it with, the budget for the dollar figures.
  const scope = { orgId: team?.orgId, teamId: team?.id };
  const canSeeSettings = useCan('team.settings.manage', scope);
  const canSeeManage = useCan('team.attention.read', scope);
  const canManageBudget = useCan('team.budget.manage', scope);
  const canManageMembers = useCan('team.members.manage', scope);
  // Open join requests, counted on the Members tab for those who decide them.
  const overview = useTeamOverview(team?.id, { enabled: canManageMembers });
  const pendingRequests = canManageMembers ? (overview.data?.pendingJoinRequests ?? 0) : 0;

  useEntityTitle(team?.name);
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
    const waiting =
      memberTeams.isLoading || permissions.isLoading || (isPlatformAdmin && allTeams.isLoading);
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
  // The tabs depend on what the server says the caller holds here: wait rather than flash a
  // missing Settings tab, or a not-found page on a direct link to one.
  if (permissions.isLoading) {
    return <QueryBoundary isError={false} isLoading label="team" shape="detail" />;
  }

  const tabs = TEAM_TABS.filter(
    (tab) => (tab.id !== 'settings' || canSeeSettings) && (tab.id !== 'manage' || canSeeManage)
  ).map((tab) => ({
    href: teamHref(team.slug, tab.id),
    id: tab.id,
    label: tab.label,
    ...(tab.id === 'members' && pendingRequests > 0
      ? { badge: { count: pendingRequests, label: 'pending join requests' } }
      : {}),
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
                  you: {teamRoleLabel(team.myRole)}
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
