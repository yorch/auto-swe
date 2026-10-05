'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { EpicList } from '@/components/epics/EpicList';
import { RequestList } from '@/components/requests/RequestList';
import { RequestPanel } from '@/components/requests/RequestPanel';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { useEpics } from '@/hooks/useEpics';
import { type RequestState, useRequests } from '@/hooks/useRequests';
import { parseOffset } from '@/hooks/useUrlFilters';

const PAGE_SIZE = 30;
const STATES: { label: string; value: RequestState }[] = [
  { label: 'All statuses', value: 'all' },
  { label: 'In progress', value: 'active' },
  { label: 'Needs attention', value: 'attention' },
  { label: 'Finished', value: 'finished' },
  { label: 'Failed', value: 'failed' },
];

const TYPES = [
  { label: 'All requests', value: 'all' },
  { label: 'Epics (multi-repo)', value: 'epics' },
];

function RequestsWorkspace() {
  const params = useSearchParams();
  const router = useRouter();
  const scope = params.get('scope') === 'TEAM' ? 'TEAM' : 'MINE';
  const rawState = params.get('state');
  const state = STATES.find((option) => option.value === rawState)?.value ?? 'all';
  const search = (params.get('search') ?? '').slice(0, 200);
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => setSearchDraft(search), [search]);
  const offset = parseOffset(params.get('offset'));
  const type = params.get('type') === 'epics' ? 'epics' : 'all';
  const showEpics = type === 'epics';
  const query = useRequests(
    { limit: PAGE_SIZE, offset, scope, search, state },
    { enabled: !showEpics }
  );
  const epicsQuery = useEpics({ limit: PAGE_SIZE, offset, scope }, { enabled: showEpics });
  const active = showEpics ? epicsQuery : query;
  const requests = query.data?.data ?? [];
  const epics = epicsQuery.data?.data ?? [];
  const total = active.data?.meta.total ?? 0;
  const requestId = params.get('request');
  const urlFor = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(patch)) {
        if (value) {
          next.set(key, value);
        } else {
          next.delete(key);
        }
      }
      return `/workflows${next.size ? `?${next}` : ''}`;
    },
    [params]
  );
  const update = useCallback(
    (patch: Record<string, string | null>) => {
      router.replace(urlFor(patch), { scroll: false });
    },
    [router, urlFor]
  );
  useEffect(() => {
    if (searchDraft === search) {
      return;
    }
    const timer = setTimeout(() => update({ offset: null, search: searchDraft }), 300);
    return () => clearTimeout(timer);
  }, [searchDraft, search, update]);
  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <>
            <ButtonLink href="/epics" variant="secondary">
              Multi-repo epics
            </ButtonLink>
            <ButtonLink href="/start" variant="primary">
              Start work
            </ButtonLink>
          </>
        }
        subtitle="Everything you asked for, with retries kept together."
        title="Requests"
      />
      <div className="flex flex-wrap items-end gap-4">
        <Select
          label="Type"
          onChange={(value) => update({ offset: null, type: value === 'epics' ? 'epics' : null })}
          options={TYPES}
          value={type}
        />
        <div className="flex flex-col gap-1.5">
          <span className="label-mono" id="request-scope-label">
            Scope
          </span>
          <SegmentedControl
            ariaLabel="Request scope"
            onChange={(value) => update({ offset: null, scope: value })}
            options={[
              { label: 'My requests', value: 'MINE' },
              { label: 'Team requests', value: 'TEAM' },
            ]}
            value={scope}
          />
        </div>
        {!showEpics && (
          <>
            <div className="min-w-48 flex-1">
              <Input
                label="Search requests"
                maxLength={200}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Task or ticket…"
                value={searchDraft}
              />
            </div>
            <Select
              label="Status"
              onChange={(value) => update({ offset: null, state: value })}
              options={STATES}
              value={state}
            />
          </>
        )}
      </div>
      <QueryBoundary
        error={active.error}
        isError={active.isError}
        isFetching={active.isFetching}
        isLoading={active.isLoading}
        label={showEpics ? 'epics' : 'requests'}
        onRetry={() => void active.refetch()}
      >
        {showEpics ? (
          epics.length ? (
            <EpicList epics={epics} />
          ) : (
            <EmptyState
              hint="An epic fans one brief out across several repositories."
              title="No epics yet"
            />
          )
        ) : requests.length ? (
          <RequestList hrefFor={(id) => urlFor({ request: id })} requests={requests} />
        ) : (
          <EmptyState
            action={
              <ButtonLink href="/start" variant="primary">
                Start work
              </ButtonLink>
            }
            hint={
              search || state !== 'all'
                ? 'Try another search or status.'
                : 'Start a workflow or give an agent a task.'
            }
            title={
              search || state !== 'all' ? 'No requests match these filters' : 'No requests yet'
            }
          />
        )}
        <Pagination
          hasNext={offset + PAGE_SIZE < total}
          hasPrev={offset > 0}
          onNext={() => update({ offset: String(offset + PAGE_SIZE) })}
          onPrev={() => update({ offset: String(Math.max(0, offset - PAGE_SIZE)) })}
          rangeEnd={Math.min(offset + PAGE_SIZE, total)}
          rangeStart={total ? offset + 1 : 0}
          total={total}
        />
      </QueryBoundary>
      {requestId && (
        <RequestPanel
          key={requestId}
          onClose={() => update({ request: null })}
          requestId={requestId}
        />
      )}
    </div>
  );
}

export default function RequestsPage() {
  return (
    <Suspense>
      <RequestsWorkspace />
    </Suspense>
  );
}
