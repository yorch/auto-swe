'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, use, useEffect } from 'react';
import { BackLink } from '@/components/ui/BackLink';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useTeam, useTeams } from '@/hooks/useTeams';
import { ApiError } from '@/lib/api';
import { validateRouteParam } from '@/lib/routeParams';
import { teamHref } from '@/lib/teamSpace';

/** The sections the old team page kept behind `?tab=`; they live under Settings now. */
const SETTINGS_TABS = new Set(['service-principals', 'automation', 'sandbox']);

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <BackLink href="/admin/teams" label="Teams" />
      <PageHeader title="Team" />
      {children}
    </div>
  );
}

/**
 * A team is reached by its slug, in its own space. This address carries the id, which only the
 * team list can turn into a slug, so it resolves the id and replaces itself with the space.
 */
function TeamRedirect({ id }: { id: string | null }) {
  const router = useRouter();
  const params = useSearchParams();
  const teams = useTeams();
  const listed = id ? teams.data?.find((t) => t.id === id) : undefined;
  // The list holds active teams only, and Team audit entries link here for a deactivated team
  // too: an id the list lacks is read directly.
  const missingFromList = !!id && !!teams.data && !listed;
  const direct = useTeam(missingFromList ? id : '');
  const team = listed ?? direct.data;
  const tab = params.get('tab') ?? '';
  const target = team
    ? SETTINGS_TABS.has(tab)
      ? `${teamHref(team.slug, 'settings')}?tab=${encodeURIComponent(tab)}`
      : teamHref(team.slug)
    : null;

  useEffect(() => {
    if (target) {
      router.replace(target);
    }
  }, [router, target]);

  if (target) {
    return (
      <Frame>
        <p className="text-sm text-paper-400" role="status">
          Opening the team…
        </p>
      </Frame>
    );
  }
  const directGone =
    direct.error instanceof ApiError &&
    (direct.error.status === 404 || direct.error.status === 403);
  const failed = teams.isError || (direct.isError && !directGone);
  if (id && (teams.isLoading || failed || (missingFromList && direct.isLoading))) {
    return (
      <Frame>
        <QueryBoundary
          error={teams.isError ? teams.error : direct.error}
          isError={failed}
          isFetching={teams.isFetching || direct.isFetching}
          isLoading={teams.isLoading || (missingFromList && direct.isLoading)}
          label="team"
          onRetry={() => void (teams.isError ? teams.refetch() : direct.refetch())}
          shape="detail"
        />
      </Frame>
    );
  }
  return (
    <Frame>
      <EmptyState
        action={<ButtonLink href="/admin/teams">Back to teams</ButtonLink>}
        bordered
        hint="It may have been deleted, or the link is wrong."
        icon="teams"
        title="Team not found"
      />
    </Frame>
  );
}

export default function TeamByIdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  return (
    <Suspense>
      <TeamRedirect id={validateRouteParam(rawId)} />
    </Suspense>
  );
}
