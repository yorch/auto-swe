'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
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
import { type RequestState, useRequests } from '@/hooks/useRequests';

const PAGE_SIZE = 30;
const STATES: { label: string; value: RequestState }[] = [
  { label: 'All requests', value: 'all' },
  { label: 'In progress', value: 'active' },
  { label: 'Needs attention', value: 'attention' },
  { label: 'Finished', value: 'finished' },
  { label: 'Failed', value: 'failed' },
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
  const rawOffset = Number(params.get('offset') ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const query = useRequests({ limit: PAGE_SIZE, offset, scope, search, state });
  const requests = query.data?.data ?? [];
  const total = query.data?.meta.total ?? 0;
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
          <ButtonLink href="/start" variant="primary">
            Start work
          </ButtonLink>
        }
        subtitle="Everything you asked for, with retries kept together."
        title="Requests"
      />
      <div className="flex flex-wrap items-end gap-4">
        <SegmentedControl
          ariaLabel="Request scope"
          onChange={(value) => update({ offset: null, scope: value })}
          options={[
            { label: 'My requests', value: 'MINE' },
            { label: 'Team requests', value: 'TEAM' },
          ]}
          value={scope}
        />
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
      </div>
      <QueryBoundary
        error={query.error}
        isError={query.isError}
        isLoading={query.isLoading}
        label="requests"
        onRetry={() => void query.refetch()}
      >
        {requests.length ? (
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
