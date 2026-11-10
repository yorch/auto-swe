'use client';

import type { MeSummary } from '@auto-swe/shared/types/api';
import type { UseQueryResult } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { MyTeams } from '@/components/desk/MyTeams';
import { NeedsYouList } from '@/components/desk/NeedsYouList';
import { HowItWorks } from '@/components/help/HowItWorks';
import { RequestList } from '@/components/requests/RequestList';
import { FirstRunChecklist } from '@/components/setup/FirstRunChecklist';
import { GovernanceGuide } from '@/components/setup/GovernanceGuide';
import { RestoreGuides } from '@/components/setup/RestoreGuides';
import { SetupReadiness } from '@/components/setup/SetupReadiness';
import { TourLauncher } from '@/components/tour/TourLauncher';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon, type IconName } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useMeSummary } from '@/hooks/useMeSummary';
import { type RequestState, useRequests } from '@/hooks/useRequests';
import { deniedMessage } from '@/lib/accessDenied';
import { HELP_LINKS } from '@/lib/helpLinks';
import { cn, FOCUS_RING } from '@/lib/utils';

interface WorkSectionSpec {
  id: string;
  title: string;
  state: RequestState;
  icon: IconName;
  empty: { title: string; hint: string };
}

const IN_FLIGHT: WorkSectionSpec = {
  empty: {
    hint: 'Choose Start work to run a workflow, an agent or an epic.',
    title: 'No work in flight',
  },
  icon: 'runs',
  id: 'in-flight',
  state: 'active',
  title: 'In flight (mine)',
};

const RECENT: WorkSectionSpec = {
  empty: {
    hint: 'Finished work appears here. A successful run still needs your review.',
    title: 'No results yet',
  },
  icon: 'checkCircle',
  id: 'recent-results',
  state: 'success',
  title: 'Recent results (mine)',
};

function listHref(state: RequestState) {
  return `/requests?scope=MINE&state=${state === 'success' ? 'finished' : state}`;
}

/** The viewer's own work across every team: the desk is not scoped to one. */
function useMine(state: RequestState) {
  return useRequests({ limit: 5, scope: 'MINE', state });
}

function WorkSection({ spec }: { spec: WorkSectionSpec }) {
  const query = useMine(spec.state);
  const requests = query.data?.data ?? [];
  const total = query.data?.meta.total ?? 0;
  return (
    <section aria-labelledby={`${spec.id}-title`} className="scroll-mt-20" id={spec.id}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2
          className="flex items-center gap-2 text-lg font-semibold tracking-tight text-paper-100"
          id={`${spec.id}-title`}
        >
          {spec.title}
          {total > 0 && (
            <span className="tabular rounded-full bg-ink-600 px-2 text-xs font-medium text-paper-300">
              {total}
            </span>
          )}
        </h2>
        <Link
          className={cn(
            'inline-flex items-center gap-1 rounded-sm text-sm text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
            FOCUS_RING
          )}
          href={listHref(spec.state)}
        >
          View all
          <span className="sr-only"> {spec.title.toLowerCase()}</span>
          <Icon name="arrowRight" size={13} />
        </Link>
      </div>
      <QueryBoundary
        error={query.error}
        isError={query.isError}
        isFetching={query.isFetching}
        isLoading={query.isLoading}
        label={spec.title.toLowerCase()}
        loading={
          <Card className="px-5 py-3">
            <SkeletonRows rows={3} />
          </Card>
        }
        onRetry={() => void query.refetch()}
      >
        {requests.length ? (
          <RequestList
            density="compact"
            hrefFor={(id) =>
              `/requests?${new URLSearchParams({ request: id, scope: 'MINE' }).toString()}`
            }
            requests={requests}
          />
        ) : (
          <EmptyState
            bordered
            className="py-7"
            hint={spec.empty.hint}
            icon={spec.icon}
            title={spec.empty.title}
          />
        )}
      </QueryBoundary>
    </section>
  );
}

/** Cross-team "Needs you" and "My teams" from one summary query. */
function DeskSummary({ summary }: { summary: UseQueryResult<MeSummary> }) {
  return (
    <QueryBoundary
      error={summary.error}
      isError={summary.isError && !summary.data}
      isFetching={summary.isFetching}
      isLoading={summary.isLoading}
      label="what needs you"
      loading={
        <Card className="px-5 py-3">
          <SkeletonRows rows={3} />
        </Card>
      }
      onRetry={() => void summary.refetch()}
    >
      {summary.data && (
        <div className="space-y-8">
          <NeedsYouList items={summary.data.needsYou.items} total={summary.data.needsYou.total} />
          <MyTeams teams={summary.data.teams} />
        </div>
      )}
    </QueryBoundary>
  );
}

const START_OPTIONS: { href: string; icon: IconName; title: string; hint: string }[] = [
  {
    hint: 'A reusable process with checks and approvals',
    href: '/start?mode=workflow',
    icon: 'workflows',
    title: 'Run a workflow',
  },
  {
    hint: 'One agent, one task, on one repository',
    href: '/start?mode=agent',
    icon: 'agents',
    title: 'Run an agent',
  },
  {
    hint: 'One brief across several repositories',
    href: '/start?mode=epic',
    icon: 'epics',
    title: 'Run a multi-repo epic',
  },
];

function QuickStart() {
  return (
    <Card className="p-5">
      <h2 className="text-lg font-semibold tracking-tight text-paper-100">Start something new</h2>
      <p className="mt-1 text-sm text-paper-400">
        Pick how you want to work. You review everything before it launches.
      </p>
      <ul className="mt-4 space-y-1">
        {START_OPTIONS.map((option) => (
          <li key={option.href}>
            <Link
              className={cn(
                'group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-ink-600/50',
                FOCUS_RING
              )}
              href={option.href}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-ink-400 bg-ink-800 text-paper-300">
                <Icon name={option.icon} size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-paper-100">{option.title}</span>
                <span className="block text-xs text-paper-500">{option.hint}</span>
              </span>
              <Icon
                className="text-paper-600 transition-colors group-hover:text-paper-300"
                name="chevronRight"
                size={16}
              />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Why the user landed here, when a role-gated page sent them Home. */
function AccessDeniedNotice() {
  const params = useSearchParams();
  const router = useRouter();
  const fresh = deniedMessage(params.get('denied'), params.get('need'), params.get('reason'));
  // Keep the notice, then drop the parameters so a reload or a shared link does not repeat it.
  const [message, setMessage] = useState<string | null>(fresh);
  useEffect(() => {
    if (fresh) {
      setMessage(fresh);
    }
    if (params.has('denied')) {
      router.replace('/', { scroll: false });
    }
  }, [fresh, params, router]);
  return message ? (
    <Alert
      action={
        <Button onClick={() => setMessage(null)} size="sm" variant="ghost">
          Dismiss
        </Button>
      }
      variant="warning"
    >
      {message}
    </Alert>
  ) : null;
}

export default function HomePage() {
  const summary = useMeSummary();
  const inFlight = useMine('active');
  // QuickStart only once both are known to be empty: never flash it while loading or on error.
  const nothingToDo =
    summary.isSuccess &&
    summary.data.needsYou.total === 0 &&
    inFlight.isSuccess &&
    inFlight.data.meta.total === 0;
  return (
    <div className="space-y-8">
      <Suspense fallback={null}>
        <AccessDeniedNotice />
      </Suspense>
      <PageHeader
        actions={
          <>
            <TourLauncher />
            <ButtonLink href="/library" variant="secondary">
              Browse workflows
            </ButtonLink>
            <ButtonLink href="/start" variant="primary">
              <Icon name="plus" size={14} />
              Start work
            </ButtonLink>
          </>
        }
        learnMore={{ ...HELP_LINKS.concepts, label: 'Requests, runs and gates explained' }}
        subtitle="See what needs you, follow your work, and review the results."
        title="My desk"
      />
      <HowItWorks />
      <SetupReadiness />
      <FirstRunChecklist />
      <DeskSummary summary={summary} />
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-8">
          <WorkSection spec={IN_FLIGHT} />
          <WorkSection spec={RECENT} />
        </div>
        {nothingToDo && (
          <aside aria-label="Get started" className="space-y-6">
            <QuickStart />
          </aside>
        )}
      </div>
      <GovernanceGuide />
      <RestoreGuides />
    </div>
  );
}
