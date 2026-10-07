'use client';

import { Suspense, use } from 'react';
import { RunListItem } from '@/components/runs/RunListItem';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Toolbar } from '@/components/ui/Toolbar';
import {
  TemplateBackLink,
  TemplateNotFound,
  TemplateSubNav,
} from '@/components/workflow/templateNav';
import { useAllWorkflowRuns } from '@/hooks/useRuns';
import { useWorkflowTemplate } from '@/hooks/useTemplates';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { nodeTitlesOf } from '@/lib/nodeTitles';
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
  // Set by the step table on the analytics page: only runs in which that node failed.
  const failedNodeId = params.get('failedStep') ?? '';

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
    ...(failedNodeId ? { failedNodeId } : {}),
  });

  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  // Every version the template has, not just those on the loaded page. The
  // template query can fail for a shared-repository viewer; the dropdown then
  // has nothing to list and stays hidden, and the runs still load.
  const versions = (template?.versions ?? []).map((v) => v.version).sort((a, b) => b - a);

  const nodeTitles = nodeTitlesOf(template?.activeVersionSpec?.spec);

  const handlePrev = () =>
    update({ offset: offset - PAGE_SIZE > 0 ? String(offset - PAGE_SIZE) : null });
  const handleNext = () => update({ offset: String(offset + PAGE_SIZE) });

  if (!id) {
    return <TemplateNotFound />;
  }

  const filtering = Boolean(statusFilter || versionFilter || failedNodeId);
  const runnable = template?.status === 'ACTIVE' && template.activeVersion !== null;

  return (
    <div className="space-y-6">
      <div>
        <TemplateBackLink href={`/workflows/library/${id}`} label={template?.name ?? 'Workflow'} />
        <PageHeader
          actions={
            runnable ? (
              <ButtonLink
                href={`/start?template=${encodeURIComponent(id)}`}
                size="sm"
                variant="primary"
              >
                Run
                <Icon name="arrowRight" size={13} />
              </ButtonLink>
            ) : undefined
          }
          className="mt-3 mb-0"
          subtitle="Every run of this workflow, newest first. Open one to see its request; use Diagnostics for the full trace."
          title="Run history"
        />
      </div>

      <TemplateSubNav active="runs" templateId={id} />

      <Card className="p-0">
        <Toolbar
          className="mb-0 border-b border-ink-600 px-4 py-3 sm:px-5"
          end={
            data ? (
              <span className="text-xs text-paper-500 tabular-nums">
                {total === 1 ? '1 run' : `${total} runs`}
              </span>
            ) : null
          }
        >
          <Select
            aria-label="Filter by status"
            className="h-8 w-full text-[13px] sm:w-44"
            compact
            id="run-status-filter"
            onChange={(v) => update({ offset: null, status: v })}
            options={RUN_STATUSES.map((s) => ({ label: s.label, value: s.value }))}
            value={statusFilter}
          />
          {versions.length > 1 && (
            <Select
              aria-label="Filter by version"
              className="h-8 w-full text-[13px] sm:w-36"
              compact
              id="run-version-filter"
              onChange={(v) => update({ offset: null, version: v })}
              options={[
                { label: 'All versions', value: '' },
                ...versions.map((v) => ({ label: `v${v}`, value: String(v) })),
              ]}
              value={versionFilter}
            />
          )}
          {failedNodeId && (
            <span className="inline-flex h-8 items-center gap-2 rounded-md border border-brick-400/30 bg-brick-400/5 pr-1 pl-2.5 text-[13px] text-paper-200">
              <Icon className="text-brick-400" name="filter" size={13} />
              <span className="max-w-[16rem] truncate">
                Failed at “{nodeTitles.get(failedNodeId) ?? failedNodeId}”
              </span>
              <Button
                className="h-6 px-2"
                onClick={() => update({ failedStep: null, offset: null })}
                size="sm"
                variant="ghost"
              >
                Clear
              </Button>
            </span>
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
        </Toolbar>

        <QueryBoundary
          error={error}
          isError={isError}
          isFetching={isFetching}
          isLoading={false}
          label="runs"
          onRetry={() => void refetch()}
        >
          {isLoading ? (
            <SkeletonRows className="px-5 py-4" rows={6} />
          ) : rows.length === 0 ? (
            filtering ? (
              <EmptyState
                action={
                  <Button
                    onClick={() =>
                      update({ failedStep: null, offset: null, status: null, version: null })
                    }
                    size="sm"
                  >
                    Clear all filters
                  </Button>
                }
                hint="Try another status or version."
                icon="filter"
                title="No runs match these filters"
              />
            ) : (
              <EmptyState
                action={
                  runnable ? (
                    <ButtonLink href={`/start?template=${encodeURIComponent(id)}`} size="sm">
                      Run this workflow
                    </ButtonLink>
                  ) : undefined
                }
                hint="Each run of this workflow shows up here with its status, cost and request."
                icon="runs"
                title="No runs yet"
              />
            )
          ) : (
            <ul className="divide-y divide-ink-600">
              {rows.map((r) => (
                <RunListItem key={r.id} run={r} />
              ))}
            </ul>
          )}

          {total > PAGE_SIZE && (
            <div className="border-t border-ink-600 px-4 py-3 sm:px-5">
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
      </Card>
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
