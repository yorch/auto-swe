'use client';

import { usePathname } from 'next/navigation';
import { type ReactNode, use, useEffect, useRef } from 'react';
import NotFound from '@/app/not-found';
import { RoleModelHint } from '@/components/RoleModelHint';
import { TeamSpaceProvider } from '@/components/teams/space/TeamSpaceContext';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { TabBar } from '@/components/ui/TabBar';
import { useCanState, usePlatformAdmin } from '@/hooks/useCan';
import { useEffectivePermissions } from '@/hooks/useEffectivePermissions';
import { useEntityTitle } from '@/hooks/useEntityTitle';
import { useTeamOverview } from '@/hooks/useTeamOverview';
import { useTeams } from '@/hooks/useTeams';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { teamEntry } from '@/lib/capabilities';
import { teamRoleLabel } from '@/lib/roleLabels';
import { validateRouteParam } from '@/lib/routeParams';
import { TEAM_TABS, type TeamTabId, teamHref, teamTabFromPath } from '@/lib/teamSpace';

/**
 * One team's space. The slug in the address is the scope: it resolves through the caller's own
 * teams and then through the teams they can list without belonging to (an organization admin's
 * administered teams, a platform admin's every team), without a role badge. A slug that names no
 * team they can see renders the ordinary not-found page, which says nothing about whether such a
 * team exists.
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
  const permissions = useEffectivePermissions();
  const memberTeams = useTeams({ memberOnly: true });
  const allTeams = useTeams();
  const platformAdmin = usePlatformAdmin();
  const { loaded, lastTeamSlug, setLastTeamSlug } = useUserPreferences();

  const team =
    (slug ? memberTeams.data?.find((t) => t.slug === slug) : undefined) ??
    (slug ? allTeams.data?.find((t) => t.slug === slug) : undefined);
  // What the tabs offer is what the server says the caller holds on this team: Settings for the
  // team's configuration, Manage for what its leads run it with, the budget for the dollar figures.
  const scope = { orgId: team?.orgId, teamId: team?.id };
  const settingsState = useCanState('team.settings.manage', scope);
  const manageState = useCanState('team.attention.read', scope);
  const budgetState = useCanState('team.budget.manage', scope);
  const membersState = useCanState('team.members.manage', scope);
  const canSeeSettings = settingsState.allowed;
  const canSeeManage = manageState.allowed;
  const canManageBudget = budgetState.allowed;
  const canManageMembers = membersState.allowed;
  const checks = [settingsState, manageState, budgetState, membersState];
  // An organization admin without a team role is described by a per-team answer that arrives after
  // the team resolves: wait for it, and show its failure, instead of a missing tab or a not-found.
  const checking = checks.some((c) => c.pending);
  const checkFailed = checks.find((c) => c.error);
  // Open join requests, counted on the Members tab for those who decide them.
  const overview = useTeamOverview(team?.id, { enabled: canManageMembers });
  const pendingRequests = canManageMembers ? (overview.data?.pendingJoinRequests ?? 0) : 0;

  // Which authority the person acts under here, beside their own team role: a non-member reaches
  // the team as an organization admin or a platform admin, and a member may hold governance on it
  // through their organization too (the server tags each held capability with its authority).
  // The team's own answer names the org authority only where the team role does not already confer
  // the capability, so a lead who is also an org admin is read from the organization's entry: it
  // holds `org.members.manage` only through the organization's admin authority.
  const viaOrg =
    !!team &&
    !!permissions.data &&
    (teamEntry(permissions.data, team.id)?.capabilities.some(
      (c) => c.key === 'team.members.manage' && c.authority === 'org-admin'
    ) === true ||
      permissions.data.organizations?.some(
        (o) => o.orgId === team.orgId && o.capabilities.some((c) => c.key === 'org.members.manage')
      ) === true);
  const accessChip = !team
    ? null
    : team.myRole
      ? viaOrg
        ? 'and org admin'
        : null
      : platformAdmin
        ? 'Platform admin'
        : `Org admin of ${team.orgName}`;

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
    const waiting = memberTeams.isLoading || permissions.isLoading || allTeams.isLoading;
    const failed = memberTeams.isError || allTeams.isError;
    if (waiting || failed) {
      const failing = memberTeams.isError ? memberTeams : allTeams;
      return (
        <QueryBoundary
          error={failing.error}
          isError={failed && !waiting}
          isFetching={failing.isFetching}
          isLoading={waiting}
          label="team"
          onRetry={() => {
            for (const q of [memberTeams, allTeams]) {
              if (q.isError) {
                void q.refetch();
              }
            }
          }}
          shape="detail"
        />
      );
    }
    return <NotFound />;
  }
  // The tabs depend on what the server says the caller holds here: wait rather than flash a
  // missing Settings tab, or a not-found page on a direct link to one.
  if (permissions.isLoading || checking) {
    return <QueryBoundary isError={false} isLoading label="team" shape="detail" />;
  }
  if (checkFailed) {
    return (
      <QueryBoundary
        error={checkFailed.error}
        isError
        isFetching={false}
        isLoading={false}
        label="team permissions"
        onRetry={() => {
          for (const c of checks) {
            if (c.error) {
              c.retry();
            }
          }
        }}
        shape="detail"
      />
    );
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
              {accessChip && (
                <Badge tone="accent" variant="outline">
                  {accessChip}
                </Badge>
              )}
              {accessChip && <RoleModelHint className="basis-full" />}
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
