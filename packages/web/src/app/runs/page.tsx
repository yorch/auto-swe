'use client';

import { Suspense } from 'react';
import { RunListItem } from '@/components/runs/RunListItem';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { useAllWorkflowRuns } from '@/hooks/useRuns';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { isRunStatus, runStatusOptions } from '@/lib/runStatusOptions';

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

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle={`Every workflow run, filterable by status and workflow — ${total} total. Open a run to see its request; use Diagnostics for the full trace.`}
        title="All runs"
      />

      <Card variant="inset">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Select
            id="status"
            label="Status"
            onChange={(v) => update({ offset: null, status: v })}
            options={STATUS_OPTIONS}
            value={status}
          />
          <Combobox
            id="template"
            label="Workflow"
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
          className="mt-3"
          label="Show channel runs"
          onChange={(e) => update({ channel: e.target.checked ? '1' : null, offset: null })}
        />
      </Card>

      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="runs"
        onRetry={() => void refetch()}
      >
        {runs.length === 0 ? (
          hasFilters ? (
            <EmptyState title="No runs match these filters" />
          ) : (
            <EmptyState
              action={
                <ButtonLink href="/start" variant="primary">
                  Start work
                </ButtonLink>
              }
              hint="Runs appear here once work has been started."
              title="No runs yet"
            />
          )
        ) : (
          <Card className="overflow-hidden p-0">
            <ul className="divide-y divide-ink-600">
              {runs.map((run) => (
                <RunListItem key={run.id} run={run} />
              ))}
            </ul>
          </Card>
        )}
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
      </QueryBoundary>
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
