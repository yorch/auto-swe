'use client';

import { Suspense, useRef } from 'react';
import { RunsTable } from '@/components/runs/RunsTable';
import { useRunsSearch } from '@/components/runs/useRunsSearch';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { useDebouncedUrlSearch } from '@/hooks/useDebouncedUrlSearch';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { isRunStatus, runStatusOptions } from '@/lib/runStatusOptions';
import { plural } from '@/lib/utils';

const PAGE_SIZE = 50;
const STATUS_OPTIONS = runStatusOptions();

function RunsList() {
  const { params, update } = useUrlFilters();
  const rawStatus = params.get('status') ?? '';
  const status = isRunStatus(rawStatus) ? rawStatus : '';
  const templateId = (params.get('template') ?? '').slice(0, 64);
  const includeChannel = params.get('channel') === '1';
  const offset = parseOffset(params.get('offset'));
  const { data: templates = [] } = useWorkflowTemplates();
  const q = (params.get('q') ?? '').slice(0, 200);
  const scope = params.get('scope') === 'MINE' ? 'MINE' : 'ALL';
  const [searchDraft, setSearchDraft] = useDebouncedUrlSearch(q, (value) =>
    update({ offset: null, q: value.trim() || null })
  );
  const { data, error, isError, isFetching, isLoading, refetch } = useRunsSearch({
    includeChannel,
    limit: PAGE_SIZE,
    offset,
    q,
    scope: scope === 'MINE' ? 'MINE' : undefined,
    status: status || undefined,
    templateId: templateId || undefined,
  });
  const tableTop = useRef<HTMLDivElement>(null);
  const goToOffset = (next: number) => {
    update({ offset: next > 0 ? String(next) : null });
    // The new page starts at its first row, not wherever the buttons were.
    tableTop.current?.scrollIntoView?.({ block: 'start' });
  };

  const runs = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  const hasFilters = !!status || !!templateId || includeChannel || !!q || scope === 'MINE';
  const clearFilters = () => {
    setSearchDraft('');
    update({ channel: null, offset: null, q: null, scope: null, status: null, template: null });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        help={
          <p>
            A run is one execution of a workflow template. The title opens the run's request;
            Diagnostics opens the full trace, graph and timeline. Search matches the request's
            title, description or ticket, and the workflow's name.
          </p>
        }
        subtitle="Every run across your teams."
        title="All runs"
      />

      <div className="scroll-mt-4" ref={tableTop}>
        <Card className="overflow-hidden p-0">
          <Toolbar
            className="mb-0 border-b border-ink-600 px-4 py-3 sm:px-5"
            end={
              <>
                {hasFilters && (
                  <Button onClick={clearFilters} size="sm" variant="ghost">
                    Clear filters
                  </Button>
                )}
                {!isLoading && !isError && (
                  <span className="tabular text-xs text-paper-500">
                    {total > 0 && total > runs.length
                      ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${plural(total, 'run')}`
                      : plural(total, 'run')}
                  </span>
                )}
              </>
            }
          >
            <SearchInput
              label="Search runs"
              onChange={(value) => setSearchDraft(value.slice(0, 200))}
              placeholder="Search by task, ticket or workflow…"
              value={searchDraft}
            />
            <SegmentedControl
              ariaLabel="Run scope"
              onChange={(value) =>
                update({ offset: null, scope: value === 'MINE' ? 'MINE' : null })
              }
              options={[
                { label: 'All runs', title: 'Every run you can see', value: 'ALL' },
                { label: 'My runs', title: 'Runs of requests you made', value: 'MINE' },
              ]}
              value={scope}
            />
            <Select
              aria-label="Status"
              className="w-full sm:w-44"
              compact
              id="status"
              onChange={(v) => update({ offset: null, status: v })}
              options={STATUS_OPTIONS}
              value={status}
            />
            <div className="w-full sm:w-64">
              <Combobox
                aria-label="Workflow"
                compact
                id="template"
                onChange={(v) => update({ offset: null, template: v })}
                options={[
                  { label: 'All workflows', value: '' },
                  ...templates.map((t) => ({ label: t.name, value: t.id })),
                ]}
                value={templateId}
              />
            </div>
            <Checkbox
              checked={includeChannel}
              className="items-center text-sm sm:ml-1"
              label="Include channel runs"
              onChange={(e) => update({ channel: e.target.checked ? '1' : null, offset: null })}
            />
          </Toolbar>

          {isLoading ? (
            <RunsTable isLoading runs={[]} />
          ) : (
            <div className={isError ? 'p-4 sm:p-5' : undefined}>
              <QueryBoundary
                error={error}
                isError={isError}
                isFetching={isFetching}
                isLoading={false}
                label="runs"
                onRetry={() => void refetch()}
              >
                {runs.length === 0 ? (
                  hasFilters ? (
                    <EmptyState
                      action={
                        <Button onClick={clearFilters} size="sm">
                          Clear filters
                        </Button>
                      }
                      hint="Try another search, status or workflow, or clear the filters to see every run."
                      icon="filter"
                      title="No runs match these filters"
                    />
                  ) : (
                    <EmptyState
                      action={
                        <ButtonLink href="/start" variant="primary">
                          Start work
                        </ButtonLink>
                      }
                      hint="Each time a workflow runs — from a ticket, a schedule or the Start page — it is listed here with its status, duration and cost."
                      icon="runs"
                      title="No runs yet"
                    />
                  )
                ) : (
                  <RunsTable runs={runs} />
                )}
              </QueryBoundary>
            </div>
          )}

          {(total > PAGE_SIZE || offset > 0) && (
            <div className="border-t border-ink-600 px-4 py-3 sm:px-5">
              <Pagination
                hasNext={offset + PAGE_SIZE < total}
                hasPrev={offset > 0}
                onNext={() => goToOffset(offset + PAGE_SIZE)}
                onPrev={() => goToOffset(offset - PAGE_SIZE)}
                rangeEnd={Math.min(offset + PAGE_SIZE, total)}
                rangeStart={total === 0 ? 0 : offset + 1}
                total={total}
              />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function WorkflowRunsPage() {
  return (
    <Suspense>
      <RunsList />
    </Suspense>
  );
}
