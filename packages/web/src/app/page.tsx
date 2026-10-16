'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { HumanStepCard } from '@/components/approvals/HumanStepCard';
import { HowItWorks } from '@/components/help/HowItWorks';
import { RequestList } from '@/components/requests/RequestList';
import { FirstRunChecklist } from '@/components/setup/FirstRunChecklist';
import { GovernanceGuide } from '@/components/setup/GovernanceGuide';
import { SetupReadiness } from '@/components/setup/SetupReadiness';
import { TourLauncher } from '@/components/tour/TourLauncher';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Skeleton, SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useApprovals } from '@/hooks/useApprovals';
import { type RequestScope, type RequestState, useRequests } from '@/hooks/useRequests';
import { deniedMessage } from '@/lib/accessDenied';
import { HELP_LINKS } from '@/lib/helpLinks';
import { cn, FOCUS_RING } from '@/lib/utils';

/** One request bucket on Home: its list section and its overview tile share this. */
interface Bucket {
  id: string;
  title: string;
  state: RequestState;
  icon: IconName;
  /** Tile colour when the bucket is non-empty. */
  tone: string;
  empty: { title: string; hint: string };
}

const BUCKETS: Bucket[] = [
  {
    empty: {
      hint: 'Failed runs, blocked steps and pull requests ready for review show up here.',
      title: 'Nothing needs your attention',
    },
    icon: 'warning',
    id: 'attention',
    state: 'attention',
    title: 'Needs your attention',
    tone: 'text-warning-400',
  },
  {
    empty: {
      hint: 'Use Start something new to run a workflow, an agent or an epic.',
      title: 'No work in progress',
    },
    icon: 'runs',
    id: 'in-progress',
    state: 'active',
    title: 'In progress',
    tone: 'text-info-400',
  },
  {
    empty: {
      hint: 'Finished work appears here. A successful run still needs your review.',
      title: 'No results yet',
    },
    icon: 'checkCircle',
    id: 'recent-results',
    state: 'success',
    title: 'Recent results',
    tone: 'text-success-400',
  },
];

function listHref(scope: RequestScope, state: RequestState) {
  return `/requests?scope=${scope}&state=${state === 'success' ? 'finished' : state}`;
}

/** Same filters as the bucket's section, so the two share one cached query. */
function useBucket(scope: RequestScope, state: RequestState) {
  return useRequests({ limit: 5, scope, state });
}

const TILE = 'flex min-w-0 flex-col rounded-xl border border-ink-400/60 bg-ink-700 p-4';

function TileBody({
  count,
  icon,
  label,
  loading,
  tone,
}: {
  count: number | undefined;
  icon: IconName;
  label: string;
  loading: boolean;
  tone: string;
}) {
  return (
    <>
      <span className="flex items-center justify-between gap-2 text-sm text-paper-400">
        {label}
        <Icon
          className={cn(count ? tone : 'text-paper-600', 'transition-colors')}
          name={icon}
          size={16}
        />
      </span>
      {loading ? (
        <Skeleton className="mt-3 h-8 w-12" />
      ) : (
        <span
          className={cn(
            'tabular mt-2 text-3xl font-semibold leading-tight tracking-tight',
            count ? 'text-paper-50' : 'text-paper-500'
          )}
        >
          {count ?? '–'}
        </span>
      )}
    </>
  );
}

function BucketTile({ bucket, scope }: { bucket: Bucket; scope: RequestScope }) {
  const query = useBucket(scope, bucket.state);
  return (
    <div className={TILE}>
      <TileBody
        count={query.data?.meta.total}
        icon={bucket.icon}
        label={bucket.title}
        loading={query.isLoading}
        tone={bucket.tone}
      />
    </div>
  );
}

function WorkSection({ bucket, scope }: { bucket: Bucket; scope: RequestScope }) {
  const query = useBucket(scope, bucket.state);
  const requests = query.data?.data ?? [];
  const total = query.data?.meta.total ?? 0;
  return (
    <section aria-labelledby={`${bucket.id}-title`} className="scroll-mt-20" id={bucket.id}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2
          className="flex items-center gap-2 text-base font-semibold text-paper-100"
          id={`${bucket.id}-title`}
        >
          {bucket.title}
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
          href={listHref(scope, bucket.state)}
        >
          View all
          <span className="sr-only"> {bucket.title.toLowerCase()}</span>
          <Icon name="arrowRight" size={13} />
        </Link>
      </div>
      <QueryBoundary
        error={query.error}
        isError={query.isError}
        isFetching={query.isFetching}
        isLoading={query.isLoading}
        label={bucket.title.toLowerCase()}
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
            hrefFor={(id) => `/requests?${new URLSearchParams({ request: id, scope }).toString()}`}
            requests={requests}
          />
        ) : (
          <EmptyState
            bordered
            className="py-7"
            hint={bucket.empty.hint}
            icon={bucket.icon}
            title={bucket.empty.title}
          />
        )}
      </QueryBoundary>
    </section>
  );
}

/** Approvals the current user can answer on any run, not only their own requests. */
function WaitingOnYou() {
  const query = useApprovals('PENDING', 'timeoutAt:asc', false, undefined, true);
  const steps = query.data ?? [];
  if (steps.length === 0) {
    return null;
  }
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-ink-600 pb-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
          <h2 className="text-lg font-semibold tracking-tight text-paper-100">Waiting on you</h2>
          <HelpTip label="Waiting on you">
            Runs that have stopped at a gate and need a person to approve, answer, or review before
            they continue. Answer them in the approvals inbox.
          </HelpTip>
          {steps.length > 5 && (
            <span className="text-sm text-paper-500">Showing 5 of {steps.length}</span>
          )}
        </div>
        <Link
          className={cn(
            'inline-flex items-center gap-1 rounded-sm text-sm text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
            FOCUS_RING
          )}
          href="/approvals"
        >
          Open approvals
          <Icon name="arrowRight" size={13} />
        </Link>
      </div>
      <div className="space-y-3">
        {steps.slice(0, 5).map((step) => (
          <HumanStepCard key={step.id} step={step} />
        ))}
      </div>
    </section>
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
      <h2 className="text-base font-semibold text-paper-100">Start something new</h2>
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
  const [scope, setScope] = useState<RequestScope>('MINE');
  return (
    <div className="space-y-8">
      <Suspense fallback={null}>
        <AccessDeniedNotice />
      </Suspense>
      <PageHeader
        actions={
          <ButtonLink href="/library" variant="secondary">
            Browse workflows
          </ButtonLink>
        }
        learnMore={{ ...HELP_LINKS.concepts, label: 'Requests, runs and gates explained' }}
        subtitle="See what needs your attention, follow your work, and review the results."
        title="Home"
      />
      <HowItWorks />
      <SetupReadiness />
      <GovernanceGuide />
      <FirstRunChecklist />
      <TourLauncher />
      <section aria-label="Overview" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-paper-300">Overview</h2>
          <SegmentedControl
            ariaLabel="Home scope"
            onChange={setScope}
            options={[
              { label: 'My work', value: 'MINE' },
              { label: 'Team work', value: 'TEAM' },
            ]}
            value={scope}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {BUCKETS.map((bucket) => (
            <BucketTile bucket={bucket} key={bucket.id} scope={scope} />
          ))}
        </div>
      </section>
      <WaitingOnYou />
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-8">
          {BUCKETS.map((bucket) => (
            <WorkSection bucket={bucket} key={bucket.id} scope={scope} />
          ))}
        </div>
        <aside aria-label="Get started" className="space-y-6">
          <QuickStart />
        </aside>
      </div>
    </div>
  );
}
