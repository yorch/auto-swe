'use client';

import { Suspense, useMemo, useRef, useState } from 'react';
import { HumanStepCard } from '@/components/approvals/HumanStepCard';
import { PageHelp } from '@/components/help/PageHelp';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import {
  type ApprovalFilter,
  type ApprovalSort,
  useApprovals,
  useApprovalsCount,
} from '@/hooks/useApprovals';
import { useDebouncedUrlSearch } from '@/hooks/useDebouncedUrlSearch';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { HELP_LINKS } from '@/lib/helpLinks';
import { navLabel } from '@/lib/navigation';

const TABS: { id: ApprovalFilter; label: string }[] = [
  { id: 'PENDING', label: 'Pending' },
  { id: 'ALL', label: 'All' },
];

const SORT_OPTIONS: { label: string; value: ApprovalSort }[] = [
  { label: 'Newest first', value: 'requestedAt:desc' },
  { label: 'Oldest first', value: 'requestedAt:asc' },
  { label: 'Due soon', value: 'timeoutAt:asc' },
  { label: 'Due last', value: 'timeoutAt:desc' },
];

const PAGE_SIZE = 20;

type KindFilter = 'all' | 'APPROVAL' | 'DECISION' | 'INPUT' | 'REVIEW';
const KIND_OPTIONS: { label: string; value: KindFilter }[] = [
  { label: 'All kinds', value: 'all' },
  { label: 'Approval', value: 'APPROVAL' },
  { label: 'Decision', value: 'DECISION' },
  { label: 'Input', value: 'INPUT' },
  { label: 'Review', value: 'REVIEW' },
];

const INTRO =
  'Steps waiting on a person — approvals, decisions, inputs and reviews — with the context to answer them.';
/** The most steps the gateway returns in one list, by tab. */
const SERVER_CAP: Record<ApprovalFilter, number> = { ALL: 200, PENDING: 100 };

function GovernApprovals() {
  const { params, update } = useUrlFilters();
  const filter: ApprovalFilter = params.get('tab') === 'ALL' ? 'ALL' : 'PENDING';
  const rawSort = params.get('sort');
  const sort = SORT_OPTIONS.find((o) => o.value === rawSort)?.value ?? 'requestedAt:desc';
  const overdueOnly = params.get('overdue') === '1';
  const rawKind = params.get('kind');
  const kind: KindFilter = KIND_OPTIONS.find((o) => o.value === rawKind)?.value ?? 'all';
  const q = (params.get('q') ?? '').slice(0, 200);
  const page = Math.floor(parseOffset(params.get('page')));
  const [searchDraft, setSearchDraft] = useDebouncedUrlSearch(q, (value) =>
    update({ page: null, q: value.trim() || null })
  );
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingTotal = useApprovalsCount();

  const {
    data: allSteps,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useApprovals(filter, sort, overdueOnly);

  const loaded = allSteps?.length ?? 0;
  const atCap = loaded >= SERVER_CAP[filter];
  const narrowed = kind !== 'all' || q.trim() !== '';
  // Kind and text narrow the steps already loaded: the gateway filters by tab, sort and
  // deadline only, so the list below is of the loaded steps and says so at the cap.
  const steps = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (allSteps ?? []).filter((s) => {
      if (kind !== 'all' && s.kind !== kind) {
        return false;
      }
      if (!needle) {
        return true;
      }
      const request = s.run.workRequest;
      return [s.title, s.description, request?.externalTicketId, request?.description].some(
        (field) => typeof field === 'string' && field.toLowerCase().includes(needle)
      );
    });
  }, [allSteps, kind, q]);
  const count = steps.length;
  const pageCount = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = steps.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const setPage = (next: number) => update({ page: next > 0 ? String(next) : null });
  const hasFilters = overdueOnly || narrowed;
  const clearFilters = () => {
    setSearchDraft('');
    update({ kind: null, overdue: null, page: null, q: null });
  };
  const onAnswered = (message: string) => {
    setAnnouncement(message);
    // The answered card is about to leave the list; keep the reader's place in it.
    listRef.current?.focus();
  };
  const tabs = TABS.map((tab) =>
    tab.id === 'PENDING' && pendingTotal > 0
      ? {
          ...tab,
          label: `Pending (${pendingTotal}${pendingTotal >= SERVER_CAP.PENDING ? '+' : ''})`,
        }
      : tab
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button disabled={isFetching} onClick={() => refetch()} size="sm" variant="secondary">
            <Icon className={isFetching ? 'animate-spin' : undefined} name="refresh" size={13} />
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
        learnMore={{ ...HELP_LINKS.approvals, label: 'About approvals' }}
        subtitle={
          isLoading || isError
            ? INTRO
            : atCap
              ? `Showing ${loaded} ${filter === 'PENDING' ? 'pending ' : ''}steps, the most this list loads. Sort or filter to see others.`
              : filter === 'PENDING'
                ? loaded === 0
                  ? INTRO
                  : `${loaded} pending action${loaded !== 1 ? 's' : ''}`
                : `${loaded} step${loaded !== 1 ? 's' : ''} total`
        }
        title={navLabel('/approvals')}
      />

      <PageHelp>
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-paper-100">What these steps are</h3>
          <p>
            Each is a gate <HelpTip term="gate" /> that waits for a person.
          </p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              <span className="font-mono text-paper-200">humanApproval</span>: approve or reject —
              and request changes, with a note, where the workflow offers it{' '}
              <HelpTip term="approval" />.
            </li>
            <li>
              <span className="font-mono text-paper-200">humanDecision</span>: choose one of 2 to 10
              options; the choice picks the next step.
            </li>
            <li>
              <span className="font-mono text-paper-200">humanInput</span>: fill in a form; the
              values are available to later steps.
            </li>
            <li>
              <span className="font-mono text-paper-200">humanReview</span>: read content such as a
              diff and submit notes; the run then continues.
            </li>
          </ul>
          <p>
            Every one of these steps has a timeout. If nobody answers in time, the step is marked
            timed out and the run follows the node's timeout route, such as ending as timed out or
            opening the pull request. The run itself does not end unless that route ends it.
          </p>
        </section>
      </PageHelp>

      <div>
        <TabBar
          active={filter}
          idPrefix="approvals"
          onChange={(next) => update({ page: null, tab: next === 'ALL' ? 'ALL' : null })}
          tabs={tabs}
        />

        <div {...tabPanelProps('approvals', filter)} className="pt-4">
          <Toolbar>
            <SearchInput
              label="Search approvals"
              onChange={(value) => setSearchDraft(value.slice(0, 200))}
              placeholder="Search by title or ticket…"
              value={searchDraft}
            />
            <SegmentedControl<KindFilter>
              ariaLabel="Step kind"
              onChange={(value) => update({ kind: value === 'all' ? null : value, page: null })}
              options={KIND_OPTIONS}
              value={kind}
            />
            <Select
              aria-label="Sort"
              className="w-full sm:w-44"
              compact
              onChange={(v) => update({ page: null, sort: v === 'requestedAt:desc' ? null : v })}
              options={SORT_OPTIONS}
              value={sort}
            />

            <Checkbox
              checked={overdueOnly}
              className="items-center text-sm"
              label="Overdue only"
              onChange={(e) => update({ overdue: e.target.checked ? '1' : null, page: null })}
            />
            {hasFilters && (
              <Button onClick={clearFilters} size="sm" variant="ghost">
                Clear filters
              </Button>
            )}
          </Toolbar>

          {/* The live region stays mounted and only its content changes: one inserted already filled is often not announced. */}
          <div aria-live="polite" className={announcement ? 'mb-3' : undefined} role="status">
            {announcement && (
              <Alert announce={false} variant="success">
                {announcement}
              </Alert>
            )}
          </div>

          <QueryBoundary
            error={error}
            isError={isError}
            isFetching={isFetching}
            isLoading={isLoading}
            label="inbox"
            loading={<ApprovalSkeleton />}
            onRetry={() => void refetch()}
          >
            {count > 0 && (
              <div className="space-y-3 outline-none" ref={listRef} tabIndex={-1}>
                {narrowed && atCap && (
                  <p className="text-xs text-paper-500">
                    Searching the {loaded} steps this list loads; others may match.
                  </p>
                )}
                {visible.map((step) => (
                  <HumanStepCard
                    defaultExpanded={filter === 'PENDING' && loaded === 1 && !narrowed}
                    key={step.id}
                    onAnswered={onAnswered}
                    step={step}
                  />
                ))}
                {count > PAGE_SIZE && (
                  <div className="pt-2">
                    <Pagination
                      hasNext={current < pageCount - 1}
                      hasPrev={current > 0}
                      onNext={() => setPage(current + 1)}
                      onPrev={() => setPage(current - 1)}
                      rangeEnd={Math.min(count, (current + 1) * PAGE_SIZE)}
                      rangeStart={current * PAGE_SIZE + 1}
                      total={count}
                    />
                  </div>
                )}
              </div>
            )}

            {count === 0 &&
              (hasFilters ? (
                <EmptyState
                  action={
                    <Button onClick={clearFilters} size="sm">
                      Clear filters
                    </Button>
                  }
                  bordered
                  hint={
                    overdueOnly && !narrowed
                      ? 'Nothing has passed its deadline. Clear the filter to see the rest.'
                      : 'No step matches the search, kind and deadline filters.'
                  }
                  icon={overdueOnly && !narrowed ? 'clock' : 'filter'}
                  title={overdueOnly && !narrowed ? 'No overdue steps' : 'No steps match'}
                />
              ) : filter === 'PENDING' ? (
                <EmptyState
                  action={
                    <Button onClick={() => update({ page: null, tab: 'ALL' })} size="sm">
                      See answered steps
                    </Button>
                  }
                  bordered
                  hint="When a run reaches an approval, decision, input or review step, it waits here for a person to answer."
                  icon="inbox"
                  title="You're all caught up"
                />
              ) : (
                <EmptyState
                  action={
                    <ButtonLink href="/library" size="sm">
                      Browse workflows
                    </ButtonLink>
                  }
                  bordered
                  hint="Steps that need a person appear here once a workflow with a human step runs."
                  icon="inbox"
                  title="No human steps yet"
                />
              ))}
          </QueryBoundary>
        </div>
      </div>
    </div>
  );
}

export default function GovernApprovalsPage() {
  return (
    <Suspense>
      <GovernApprovals />
    </Suspense>
  );
}

/** The inbox's shape while it loads: a few step cards. */
function ApprovalSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-3" role="status">
      <span className="sr-only">Loading approvals</span>
      {['a', 'b', 'c'].map((key) => (
        <div className="rounded-xl border border-ink-400/40 bg-ink-900/50 p-4" key={key}>
          <div className="flex items-start gap-3">
            <Skeleton className="h-5 w-16" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-7 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
