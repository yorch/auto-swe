'use client';

import { Suspense } from 'react';
import { RunListItem } from '@/components/runs/RunListItem';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Toolbar } from '@/components/ui/Toolbar';
import { useAllWorkflowRuns } from '@/hooks/useRuns';
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
  const { data, error, isError, isFetching, isLoading, refetch } = useAllWorkflowRuns({
    includeChannel,
    limit: PAGE_SIZE,
    offset,
    status: status || undefined,
    templateId: templateId || undefined,
  });

  const runs = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  const hasFilters = !!status || !!templateId || includeChannel;
  const clearFilters = () => update({ channel: null, offset: null, status: null, template: null });

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="Every workflow run across your teams. The title opens the run's request; Diagnostics opens the full trace, graph and timeline."
        title="All runs"
      />

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
                <span className="tabular text-xs text-paper-500">{plural(total, 'run')}</span>
              )}
            </>
          }
        >
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
            className="items-center text-[13px] sm:ml-1"
            label="Include channel runs"
            onChange={(e) => update({ channel: e.target.checked ? '1' : null, offset: null })}
          />
        </Toolbar>

        {isLoading ? (
          <SkeletonRows className="px-5 py-4" rows={6} />
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
                    hint="Try another status or workflow, or clear the filters to see every run."
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
                <ul className="divide-y divide-ink-600">
                  {runs.map((run) => (
                    <RunListItem key={run.id} run={run} />
                  ))}
                </ul>
              )}
            </QueryBoundary>
          </div>
        )}

        {(total > PAGE_SIZE || offset > 0) && (
          <div className="border-t border-ink-600 px-4 py-3 sm:px-5">
            <Pagination
              hasNext={offset + PAGE_SIZE < total}
              hasPrev={offset > 0}
              onNext={() => update({ offset: String(offset + PAGE_SIZE) })}
              onPrev={() =>
                update({ offset: offset - PAGE_SIZE > 0 ? String(offset - PAGE_SIZE) : null })
              }
              rangeEnd={Math.min(offset + PAGE_SIZE, total)}
              rangeStart={total === 0 ? 0 : offset + 1}
              total={total}
            />
          </div>
        )}
      </Card>
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
