'use client';

import { Suspense, use } from 'react';
import { RunListItem } from '@/components/runs/RunListItem';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import {
  TemplateBackLink,
  TemplateNotFound,
  TemplateSubNav,
} from '@/components/workflow/templateNav';
import { useAllWorkflowRuns } from '@/hooks/useRuns';
import { useWorkflowTemplate } from '@/hooks/useTemplates';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { validateRouteParam } from '@/lib/routeParams';
import { isRunStatus, runStatusOptions } from '@/lib/runStatusOptions';

interface PageProps {
  params: Promise<{ id: string }>;
}

const PAGE_SIZE = 20;

const RUN_STATUSES = runStatusOptions();

function TemplateRuns({ id: rawId }: { id: string }) {
  const id = validateRouteParam(rawId);
  const { data: template } = useWorkflowTemplate(id ?? '');
  const { params, update } = useUrlFilters();
  const offset = parseOffset(params.get('offset'));
  const statusFilter = params.get('status') ?? '';
  const versionFilter = /^\d{1,6}$/.test(params.get('version') ?? '')
    ? (params.get('version') ?? '')
    : '';

  // Both filters run server-side, so the total and the pagination describe
  // the filtered set. This reads /workflow-runs (not the template-scoped
  // endpoint) so a viewer who reaches the runs through a shared repository
  // still sees them.
  const { data, error, isError, isFetching, refetch, isLoading } = useAllWorkflowRuns({
    limit: PAGE_SIZE,
    offset,
    status: isRunStatus(statusFilter) ? statusFilter : undefined,
    templateId: id ?? undefined,
    templateVersion: versionFilter ? Number(versionFilter) : undefined,
  });

  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  // Every version the template has, not just those on the loaded page. The
  // template query can fail for a shared-repository viewer; the dropdown then
  // has nothing to list and stays hidden, and the runs still load.
  const versions = (template?.versions ?? []).map((v) => v.version).sort((a, b) => b - a);

  const handlePrev = () =>
    update({ offset: offset - PAGE_SIZE > 0 ? String(offset - PAGE_SIZE) : null });
  const handleNext = () => update({ offset: String(offset + PAGE_SIZE) });

  if (!id) {
    return <TemplateNotFound />;
  }

  return (
    <div className="space-y-8">
      <div>
        <TemplateBackLink href={`/workflows/library/${id}`} label={template?.name ?? 'Workflow'} />
        <PageHeader
          chapter="§ Workflows"
          className="mb-0 mt-4"
          subtitle="Every run of this workflow, newest first. Open one to see its request; use Diagnostics for the full trace."
          title="Run history"
        />
      </div>

      <TemplateSubNav active="runs" templateId={id} />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <Select
          className="w-auto"
          compact
          id="run-status-filter"
          label="Status"
          onChange={(v) => update({ offset: null, status: v })}
          options={RUN_STATUSES.map((s) => ({ label: s.label, value: s.value }))}
          value={statusFilter}
        />
        {versions.length > 1 && (
          <Select
            className="w-auto"
            compact
            id="run-version-filter"
            label="Version"
            onChange={(v) => update({ offset: null, version: v })}
            options={[
              { label: 'All versions', value: '' },
              ...versions.map((v) => ({ label: `v${v}`, value: String(v) })),
            ]}
            value={versionFilter}
          />
        )}
        {(statusFilter || versionFilter) && (
          <Button
            onClick={() => update({ offset: null, status: null, version: null })}
            size="sm"
            variant="ghost"
          >
            Clear filters
          </Button>
        )}
      </div>

      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="runs"
        loadingMessage="loading runs…"
        onRetry={() => void refetch()}
      >
        {rows.length === 0 ? (
          <EmptyState
            title={
              statusFilter || versionFilter
                ? 'No runs match the current filters.'
                : 'No runs yet — start work with this workflow to trigger one.'
            }
          />
        ) : (
          <Card className="overflow-hidden p-0" variant="inset">
            <ul className="divide-y divide-ink-600">
              {rows.map((r) => (
                <RunListItem key={r.id} run={r} />
              ))}
            </ul>
          </Card>
        )}

        {total > PAGE_SIZE && (
          <div>
            <Pagination
              hasNext={offset + PAGE_SIZE < total}
              hasPrev={offset > 0}
              onNext={handleNext}
              onPrev={handlePrev}
              rangeEnd={Math.min(offset + PAGE_SIZE, total)}
              rangeStart={offset + 1}
              total={total}
            />
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

export default function TemplateRunsPage({ params }: PageProps) {
  const { id } = use(params);
  return (
    <Suspense>
      <TemplateRuns id={id} />
    </Suspense>
  );
}
